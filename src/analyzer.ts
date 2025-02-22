/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import {Dependency, scriptReferenceToString, ServiceConfig} from './config.js';
import {findNodeAtLocation, JsonFile} from './util/ast.js';
import * as fs from './util/fs.js';
import {
  CachingPackageJsonReader,
  FileSystem,
} from './util/package-json-reader.js';
import {IS_WINDOWS} from './util/windows.js';

import {
  parseDependency,
  type PackagePath,
  type ParsedPackageWithRange,
  type ParsedScriptWithRange,
} from './analysis/dependency-parser.js';
import type {Agent} from './cli-options.js';
import type {
  ScriptConfig,
  ScriptReference,
  ScriptReferenceString,
} from './config.js';
import type {Diagnostic, MessageLocation, Range, Result} from './error.js';
import type {
  Cycle,
  DependencyOnMissingPackageJson,
  Failure,
  InvalidConfigSyntax,
} from './event.js';
import {Logger} from './logging/logger.js';
import type {
  ArrayNode,
  JsonAstNode,
  NamedAstNode,
  ValueTypes,
} from './util/ast.js';
import type {PackageJson, ScriptSyntaxInfo} from './util/package-json.js';

export interface AnalyzeResult {
  config: Result<ScriptConfig, Failure[]>;
  relevantConfigFilePaths: Set<string>;
}

/**
 * A script config that might be at any point of the analysis pipeline,
 * or have stalled at any point along that way due to errors.
 */
export type PotentiallyValidScriptConfig =
  | UnvalidatedConfig
  | LocallyValidScriptConfig
  | InvalidScriptConfig
  | ScriptConfig;

/**
 * A {@link ScriptConfig} where all fields are optional apart from `packageDir`
 * and `name`, used temporarily while package.json files are still loading.
 *
 * A script with an invalid config may stay a placeholder forever.
 */
export type UnvalidatedConfig = ScriptReference &
  Omit<Partial<ScriptConfig>, 'state' | 'dependencies'> & {
    state: 'unvalidated';
    failures: Failure[];
    dependencies?: Array<Dependency<PotentiallyValidScriptConfig>>;
  };

/**
 * A ScriptConfig that is locally valid, but whose dependencies may not have
 * resolved and checked for circular dependency errors yet.
 */
export type LocallyValidScriptConfig = Omit<
  ScriptConfig,
  'state' | 'dependencies'
> & {
  state: 'locally-valid';
  dependencies: Array<Dependency<PotentiallyValidScriptConfig>>;
};

/**
 * A ScriptConfig that is locally valid, but whose dependencies aren't.
 * For example, it depends on a script that's declared incorrectly, or its
 * dependencies form a cycle.
 *
 * This is a separate type so that we can detect this case and check each
 * script for cycles at most once.
 */
export type InvalidScriptConfig = Omit<
  ScriptConfig,
  'state' | 'dependencies'
> & {
  state: 'invalid';
  dependencies: Array<Dependency<PotentiallyValidScriptConfig>>;
  // This should also be pushed into the `dependencies` field, but this way
  // we can be sure it's here.
  dependencyFailure: Failure;
};

interface PlaceholderInfo {
  placeholder: PotentiallyValidScriptConfig;
  /**
   * A promise that resolves when this placeholder has either been upgraded to a
   * LocallyValidScriptConfig, or if that process has failed.
   */
  upgradeComplete: Promise<undefined>;
}

/**
 * Globs that will be injected into both `files` and `output`, unless
 * `allowUsuallyExcludedPaths` is `true`.
 *
 * See https://docs.npmjs.com/cli/v9/configuring-npm/package-json#files for the
 * similar list of paths that npm ignores.
 */
const DEFAULT_EXCLUDE_PATHS = [
  '!.git/',
  '!.hg/',
  '!.svn/',
  '!.wireit/',
  '!.yarn/',
  '!CVS/',
  '!node_modules/',
] as const;

const DEFAULT_LOCKFILES: Record<Agent, string[]> = {
  npm: ['package-lock.json'],
  nodeRun: ['package-lock.json'],
  yarnClassic: ['yarn.lock'],
  yarnBerry: ['yarn.lock'],
  pnpm: ['pnpm-lock.yaml'],
};

function isValidWireitScriptCommand(command: string): boolean {
  return (
    command === 'wireit' ||
    command === 'yarn run -TB wireit' ||
    // This form is useful when using package managers like yarn or pnpm which
    // do not automatically add all parent directory `node_modules/.bin`
    // folders to PATH.
    /^(\.\.\/)+node_modules\/\.bin\/wireit$/.test(command) ||
    (IS_WINDOWS && /^(\.\.\\)+node_modules\\\.bin\\wireit\.cmd$/.test(command))
  );
}

/**
 * Analyzes and validates a script along with all of its transitive
 * dependencies, producing a build graph that is ready to be executed.
 */
export class Analyzer {
  readonly #packageJsonReader;
  readonly #placeholders = new Map<ScriptReferenceString, PlaceholderInfo>();
  readonly #ongoingWorkPromises: Array<Promise<undefined>> = [];
  readonly #relevantConfigFilePaths = new Set<string>();
  readonly #agent: Agent;
  readonly #logger: Logger | undefined;

  constructor(agent: Agent, logger?: Logger, filesystem?: FileSystem) {
    this.#agent = agent;
    this.#logger = logger;
    this.#packageJsonReader = new CachingPackageJsonReader(filesystem);
  }

  /**
   * Analyze every script in each given file and return all diagnostics found.
   */
  async analyzeFiles(files: string[]): Promise<Set<Failure>> {
    await Promise.all(
      files.map(async (f) => {
        const packageDir = pathlib.dirname(f);
        const fileResult = await this.getPackageJson(packageDir);
        if (!fileResult.ok) {
          return; // will get this error below.
        }
        for (const script of fileResult.value.scripts) {
          // This starts analysis of each of the scripts in our root files.
          this.#getPlaceholder({name: script.name, packageDir});
        }
      }),
    );
    await this.#waitForAnalysisToComplete();
    // Check for cycles.
    for (const info of this.#placeholders.values()) {
      if (info.placeholder.state === 'unvalidated') {
        continue;
      }
      // We don't care about the result, if there's a cycle error it'll
      // be added to the scripts' diagnostics.
      this.#checkForCyclesAndSortDependencies(
        info.placeholder,
        new Set(),
        true,
      );
    }

    return this.#getDiagnostics();
  }

  /**
   * Load the Wireit configuration from the `package.json` corresponding to the
   * given script, repeat for all transitive dependencies, and return a build
   * graph that is ready to be executed.
   *
   * Returns a Failure if the given script or any of its transitive
   * dependencies don't exist, are configured in an invalid way, or if there is
   * a cycle in the dependency graph.
   */
  async analyze(
    root: ScriptReference,
    extraArgs: string[] | undefined,
  ): Promise<AnalyzeResult> {
    this.#logger?.log({
      type: 'info',
      detail: 'analysis-started',
      script: root,
    });
    const analyzeResult = await this.#actuallyAnalyze(root, extraArgs);
    this.#logger?.log({
      type: 'info',
      detail: 'analysis-completed',
      script: root,
      rootScriptConfig: analyzeResult.config.ok
        ? analyzeResult.config.value
        : undefined,
    });
    return analyzeResult;
  }

  async #actuallyAnalyze(
    root: ScriptReference,
    extraArgs: string[] | undefined,
  ): Promise<AnalyzeResult> {
    // We do 2 walks through the dependency graph:
    //
    // 1. A non-deterministically ordered walk, where we traverse edges as soon
    //    as they are known, to maximize the parallelism of package.json file
    //    read operations.
    //
    // 2. A depth-first walk to detect cycles.
    //
    // We can't check for cycles in the 1st walk because its non-deterministic
    // traversal order means that we could miss certain cycle configurations.
    // Plus by doing a separate DFS walk, we'll always return the exact same
    // trail in the error message for any given graph, instead of an arbitrary
    // one.
    //
    // The way we avoid getting stuck in cycles during the 1st walk is by
    // allocating an initial placeholder object for each script, and caching it
    // by package + name. Then, instead of blocking each script on its
    // dependencies (which would lead to a promise cycle if there was a cycle in
    // the configuration), we wait for all placeholders to upgrade to full
    // configs asynchronously.
    const rootPlaceholder = this.#getPlaceholder(root);

    // Note we can't use Promise.all here, because new promises can be added to
    // the promises array as long as any promise is pending.
    await this.#waitForAnalysisToComplete();
    {
      const errors = await this.#getDiagnostics();
      if (errors.size > 0) {
        return {
          config: {ok: false, error: [...errors]},
          relevantConfigFilePaths: this.#relevantConfigFilePaths,
        };
      }
    }

    // We can safely assume all placeholders have now been upgraded to full
    // configs.
    const rootConfig = rootPlaceholder.placeholder;
    if (rootConfig.state === 'unvalidated') {
      throw new Error(
        `Internal error: script ${root.name} in ${root.packageDir} is still unvalidated but had no failures`,
      );
    }
    const cycleResult = this.#checkForCyclesAndSortDependencies(
      rootConfig,
      new Set(),
      true,
    );
    if (!cycleResult.ok) {
      return {
        config: {ok: false, error: [cycleResult.error.dependencyFailure]},
        relevantConfigFilePaths: this.#relevantConfigFilePaths,
      };
    }
    const validRootConfig = cycleResult.value;
    validRootConfig.extraArgs = extraArgs;
    return {
      config: {ok: true, value: validRootConfig},
      relevantConfigFilePaths: this.#relevantConfigFilePaths,
    };
  }

  async analyzeIgnoringErrors(
    scriptReference: ScriptReference,
  ): Promise<PotentiallyValidScriptConfig> {
    await this.analyze(scriptReference, []);
    return this.#getPlaceholder(scriptReference).placeholder;
  }

  async #getDiagnostics(): Promise<Set<Failure>> {
    const failures = new Set<Failure>();
    for await (const failure of this.#packageJsonReader.getFailures()) {
      failures.add(failure);
    }
    for (const info of this.#placeholders.values()) {
      for (const failure of info.placeholder.failures) {
        failures.add(failure);
      }
    }
    for (const failure of failures) {
      const supercedes = (failure as Partial<DependencyOnMissingPackageJson>)
        .supercedes;
      if (supercedes !== undefined) {
        failures.delete(supercedes);
      }
    }
    return failures;
  }

  async #waitForAnalysisToComplete() {
    while (this.#ongoingWorkPromises.length > 0) {
      const promise =
        this.#ongoingWorkPromises[this.#ongoingWorkPromises.length - 1];
      await promise;
      // Need to be careful here. The contract of this method is that it does
      // not return until all pending analysis work is completed.
      // If there are multiple concurrent callers to this method, we want to
      // make sure that none of them hide any of the pending work from each
      // other by removing a promise from the array before it has settled.
      // So we first await the promise, and then remove it from the array if
      // it's still the final element.
      // It might not be the final element because another caller removed it,
      // or because more work was added onto the end of the array. Either
      // case is fine.
      if (
        promise ===
        this.#ongoingWorkPromises[this.#ongoingWorkPromises.length - 1]
      ) {
        void this.#ongoingWorkPromises.pop();
      }
    }
  }

  async getPackageJson(packageDir: string): Promise<Result<PackageJson>> {
    this.#relevantConfigFilePaths.add(pathlib.join(packageDir, 'package.json'));
    return this.#packageJsonReader.read(packageDir);
  }

  /**
   * Adds the given package.json files to the known set, and analyzes all
   * scripts reachable from any of them, recursively.
   *
   * Useful for whole program analysis, e.g. for "find all references" in the
   * IDE.
   */
  async analyzeAllScripts(
    packageJsonPaths: Iterable<string>,
  ): Promise<Iterable<PlaceholderInfo>> {
    const done = new Set<ScriptReferenceString>();
    const todo: ScriptReference[] = [];
    for (const file of packageJsonPaths) {
      const packageDir = pathlib.dirname(file);
      const packageJsonResult = await this.getPackageJson(packageDir);
      if (!packageJsonResult.ok) {
        continue;
      }
      for (const script of packageJsonResult.value.scripts) {
        todo.push({name: script.name, packageDir});
      }
    }

    while (true) {
      await Promise.all(
        todo.map(async (ref) => {
          await this.analyze(ref, undefined);
          done.add(scriptReferenceToString(ref));
        }),
      );
      todo.length = 0;
      for (const info of this.#placeholders.values()) {
        if (
          info.placeholder.state === 'unvalidated' &&
          !done.has(scriptReferenceToString(info.placeholder))
        ) {
          todo.push(info.placeholder);
        }
      }
      if (todo.length === 0) {
        break;
      }
    }

    return this.#placeholders.values();
  }

  /**
   * Create or return a cached placeholder script configuration object for the
   * given script reference.
   */
  #getPlaceholder(reference: ScriptReference): PlaceholderInfo {
    const scriptKey = scriptReferenceToString(reference);
    let placeholderInfo = this.#placeholders.get(scriptKey);
    if (placeholderInfo === undefined) {
      const placeholder: UnvalidatedConfig = {
        ...reference,
        state: 'unvalidated',
        failures: [],
      };
      placeholderInfo = {
        placeholder: placeholder,
        upgradeComplete: this.#upgradePlaceholder(placeholder),
      };
      this.#placeholders.set(scriptKey, placeholderInfo);
      this.#ongoingWorkPromises.push(placeholderInfo.upgradeComplete);
    }
    return placeholderInfo;
  }

  /**
   * In-place upgrade the given placeholder script configuration object to a
   * full configuration, by reading its package.json file.
   *
   * Note this method does not block on the script's dependencies being
   * upgraded; dependencies are upgraded asynchronously.
   */
  async #upgradePlaceholder(
    placeholder: UnvalidatedConfig,
  ): Promise<undefined> {
    const packageJsonResult = await this.getPackageJson(placeholder.packageDir);
    if (!packageJsonResult.ok) {
      placeholder.failures.push(packageJsonResult.error);
      return undefined;
    }
    const packageJson = packageJsonResult.value;
    placeholder.failures.push(...packageJson.failures);

    const syntaxInfo = packageJson.getScriptInfo(placeholder.name);
    if (syntaxInfo?.wireitConfigNode !== undefined) {
      await this.#handleWireitScript(
        placeholder,
        packageJson,
        syntaxInfo,
        syntaxInfo.wireitConfigNode,
      );
    } else if (syntaxInfo?.scriptNode !== undefined) {
      this.#handlePlainNpmScript(
        placeholder,
        packageJson,
        syntaxInfo.scriptNode,
      );
    } else {
      placeholder.failures.push({
        type: 'failure',
        reason: 'script-not-found',
        script: placeholder,
        diagnostic: {
          severity: 'error',
          message: `Script "${placeholder.name}" not found in the scripts section of this package.json.`,
          location: {
            file: packageJson.jsonFile,
            range: {offset: 0, length: 0},
          },
        },
      });
    }
    return undefined;
  }

  #handlePlainNpmScript(
    placeholder: UnvalidatedConfig,
    packageJson: PackageJson,
    scriptCommand: NamedAstNode<string>,
  ): void {
    if (isValidWireitScriptCommand(scriptCommand.value)) {
      placeholder.failures.push({
        type: 'failure',
        reason: 'invalid-config-syntax',
        script: placeholder,
        diagnostic: {
          severity: 'error',
          message: `This script is configured to run wireit but it has no config in the wireit section of this package.json file`,
          location: {
            file: packageJson.jsonFile,
            range: {
              length: scriptCommand.length,
              offset: scriptCommand.offset,
            },
          },
        },
      });
    }
    // It's important to in-place update the placeholder object, instead of
    // creating a new object, because other configs may be referencing this
    // exact object in their dependencies.
    const remainingConfig: LocallyValidScriptConfig = {
      ...placeholder,
      state: 'locally-valid',
      failures: placeholder.failures,
      command: scriptCommand,
      extraArgs: undefined,
      dependencies: [],
      files: undefined,
      output: undefined,
      clean: false,
      service: undefined,
      scriptAstNode: scriptCommand,
      configAstNode: undefined,
      declaringFile: packageJson.jsonFile,
      services: [],
      env: {},
    };
    Object.assign(placeholder, remainingConfig);
  }

  async #handleWireitScript(
    placeholder: UnvalidatedConfig,
    packageJson: PackageJson,
    syntaxInfo: ScriptSyntaxInfo,
    wireitConfig: NamedAstNode<ValueTypes>,
  ): Promise<void> {
    const scriptCommand = syntaxInfo.scriptNode;
    if (
      scriptCommand !== undefined &&
      !isValidWireitScriptCommand(scriptCommand.value)
    ) {
      {
        const configName = wireitConfig.name;
        placeholder.failures.push({
          type: 'failure',
          reason: 'script-not-wireit',
          script: placeholder,
          diagnostic: {
            message:
              `This command should just be "wireit", ` +
              `as this script is configured in the wireit section.`,
            severity: 'warning',
            location: {
              file: packageJson.jsonFile,
              range: {
                length: scriptCommand.length,
                offset: scriptCommand.offset,
              },
            },
            supplementalLocations: [
              {
                message: `The wireit config is here.`,
                location: {
                  file: packageJson.jsonFile,
                  range: {
                    length: configName.length,
                    offset: configName.offset,
                  },
                },
              },
            ],
          },
        });
      }
    }

    const {dependencies, encounteredError: dependenciesErrored} =
      await this.#processDependencies(placeholder, packageJson, syntaxInfo);

    let command: JsonAstNode<string> | undefined;
    let commandError = false;
    const commandAst = findNodeAtLocation(wireitConfig, ['command']) as
      | undefined
      | JsonAstNode<string>;
    if (commandAst !== undefined) {
      const result = failUnlessNonBlankString(commandAst, packageJson.jsonFile);
      if (result.ok) {
        command = result.value;
      } else {
        commandError = true;
        placeholder.failures.push(result.error);
      }
    }

    const allowUsuallyExcludedPaths = this.#processAllowUsuallyExcludedPaths(
      placeholder,
      packageJson,
      syntaxInfo,
    );

    const files = this.#processFiles(
      placeholder,
      packageJson,
      syntaxInfo,
      allowUsuallyExcludedPaths,
    );

    if (
      dependencies.length === 0 &&
      !dependenciesErrored &&
      command === undefined &&
      !commandError &&
      (files === undefined || files.values.length === 0)
    ) {
      placeholder.failures.push({
        type: 'failure',
        reason: 'invalid-config-syntax',
        script: placeholder,
        diagnostic: {
          severity: 'error',
          message: `A wireit config must set at least one of "command", "dependencies", or "files". Otherwise there is nothing for wireit to do.`,
          location: {
            file: packageJson.jsonFile,
            range: {
              length: wireitConfig.name.length,
              offset: wireitConfig.name.offset,
            },
          },
        },
      });
    }

    const output = this.#processOutput(
      placeholder,
      packageJson,
      syntaxInfo,
      command,
      allowUsuallyExcludedPaths,
    );
    const clean = this.#processClean(placeholder, packageJson, syntaxInfo);
    const service = this.#processService(
      placeholder,
      packageJson,
      syntaxInfo,
      command,
      output,
    );
    await this.#processPackageLocks(
      placeholder,
      packageJson,
      syntaxInfo,
      files,
    );

    const env = this.#processEnv(placeholder, packageJson, syntaxInfo, command);

    if (placeholder.failures.length > 0) {
      // A script with locally-determined errors doesn't get upgraded to
      // locally-valid.
      return;
    }

    // It's important to in-place update the placeholder object, instead of
    // creating a new object, because other configs may be referencing this
    // exact object in their dependencies.
    const remainingConfig: LocallyValidScriptConfig = {
      ...placeholder,
      state: 'locally-valid',
      failures: placeholder.failures,
      command,
      extraArgs: undefined,
      dependencies,
      files,
      output,
      clean,
      service,
      scriptAstNode: scriptCommand,
      configAstNode: wireitConfig,
      declaringFile: packageJson.jsonFile,
      services: [],
      env,
    };
    Object.assign(placeholder, remainingConfig);
  }

  async #processDependencies(
    placeholder: UnvalidatedConfig,
    packageJson: PackageJson,
    scriptInfo: ScriptSyntaxInfo,
  ): Promise<{
    dependencies: Array<Dependency<PotentiallyValidScriptConfig>>;
    encounteredError: boolean;
  }> {
    const dependencies: Array<Dependency<PotentiallyValidScriptConfig>> = [];
    const dependenciesAst =
      scriptInfo.wireitConfigNode &&
      findNodeAtLocation(scriptInfo.wireitConfigNode, ['dependencies']);
    let encounteredError = false;
    if (dependenciesAst === undefined) {
      return {dependencies, encounteredError};
    }
    const result = failUnlessArray(dependenciesAst, packageJson.jsonFile);
    if (!result.ok) {
      encounteredError = true;
      placeholder.failures.push(result.error);
      return {dependencies, encounteredError};
    }
    // Error if the same dependency is declared multiple times. Duplicate
    // dependencies aren't necessarily a serious problem (since we already
    // prevent double-analysis here, and double-analysis in the Executor), but
    // they may indicate that the user has made a mistake (e.g. maybe they
    // meant a different dependency).
    const uniqueDependencies = new Map<string, JsonAstNode>();
    const children = dependenciesAst.children ?? [];
    for (const maybeUnresolved of children) {
      // A dependency can be either a plain string, or an object with a "script"
      // property plus optional extra annotations.
      let specifierResult;
      let cascade = true; // Default;
      if (maybeUnresolved.type === 'string') {
        specifierResult = failUnlessNonBlankString(
          maybeUnresolved,
          packageJson.jsonFile,
        );
        if (!specifierResult.ok) {
          encounteredError = true;
          placeholder.failures.push(specifierResult.error);
          continue;
        }
      } else if (maybeUnresolved.type === 'object') {
        specifierResult = findNodeAtLocation(maybeUnresolved, ['script']);
        if (specifierResult === undefined) {
          encounteredError = true;
          placeholder.failures.push({
            type: 'failure',
            reason: 'invalid-config-syntax',
            script: {packageDir: pathlib.dirname(packageJson.jsonFile.path)},
            diagnostic: {
              severity: 'error',
              message: `Dependency object must set a "script" property.`,
              location: {
                file: packageJson.jsonFile,
                range: {
                  offset: maybeUnresolved.offset,
                  length: maybeUnresolved.length,
                },
              },
            },
          });
          continue;
        }
        specifierResult = failUnlessNonBlankString(
          specifierResult,
          packageJson.jsonFile,
        );
        if (!specifierResult.ok) {
          encounteredError = true;
          placeholder.failures.push(specifierResult.error);
          continue;
        }
        const cascadeResult = findNodeAtLocation(maybeUnresolved, ['cascade']);
        if (cascadeResult !== undefined) {
          if (cascadeResult.value === true || cascadeResult.value === false) {
            cascade = cascadeResult.value;
          } else {
            encounteredError = true;
            placeholder.failures.push({
              type: 'failure',
              reason: 'invalid-config-syntax',
              script: {packageDir: pathlib.dirname(packageJson.jsonFile.path)},
              diagnostic: {
                severity: 'error',
                message: `The "cascade" property must be either true or false.`,
                location: {
                  file: packageJson.jsonFile,
                  range: {
                    offset: cascadeResult.offset,
                    length: cascadeResult.length,
                  },
                },
              },
            });
            continue;
          }
        }
      } else {
        encounteredError = true;
        placeholder.failures.push({
          type: 'failure',
          reason: 'invalid-config-syntax',
          script: {packageDir: pathlib.dirname(packageJson.jsonFile.path)},
          diagnostic: {
            severity: 'error',
            message: `Expected a string or object, but was ${maybeUnresolved.type}.`,
            location: {
              file: packageJson.jsonFile,
              range: {
                offset: maybeUnresolved.offset,
                length: maybeUnresolved.length,
              },
            },
          },
        });
        continue;
      }

      const unresolved = specifierResult.value;
      const result = await this.#resolveDependency(
        packageJson,
        placeholder,
        unresolved,
      );
      if (!result.ok) {
        encounteredError = true;
        placeholder.failures.push(result.error);
        continue;
      }

      for (const resolved of result.value) {
        const uniqueKey = scriptReferenceToString(resolved);
        const duplicate = uniqueDependencies.get(uniqueKey);
        if (duplicate !== undefined) {
          encounteredError = true;
          placeholder.failures.push({
            type: 'failure',
            reason: 'duplicate-dependency',
            script: placeholder,
            dependency: resolved,
            diagnostic: {
              severity: 'error',
              message: `This dependency is listed multiple times`,
              location: {
                file: packageJson.jsonFile,
                range: {
                  offset: unresolved.offset,
                  length: unresolved.length,
                },
              },
              supplementalLocations: [
                {
                  message: `The dependency was first listed here.`,
                  location: {
                    file: packageJson.jsonFile,
                    range: {
                      offset: duplicate.offset,
                      length: duplicate.length,
                    },
                  },
                },
              ],
            },
          });
        }
        uniqueDependencies.set(uniqueKey, unresolved);
        const placeHolderInfo = this.#getPlaceholder(resolved);
        dependencies.push({
          specifier: unresolved,
          config: placeHolderInfo.placeholder,
          cascade,
        });
        this.#ongoingWorkPromises.push(
          (async () => {
            await placeHolderInfo.upgradeComplete;
            const failures = placeHolderInfo.placeholder.failures;
            for (const failure of failures) {
              if (failure.reason === 'script-not-found') {
                const hasColon = unresolved.value.includes(':');
                let offset;
                let length;
                if (
                  !hasColon ||
                  resolved.packageDir === placeholder.packageDir
                ) {
                  offset = unresolved.offset;
                  length = unresolved.length;
                } else {
                  // Skip past the colon
                  const colonOffsetInString = packageJson.jsonFile.contents
                    .slice(unresolved.offset)
                    .indexOf(':');
                  offset = unresolved.offset + colonOffsetInString + 1;
                  length = unresolved.length - colonOffsetInString - 2;
                }
                placeholder.failures.push({
                  type: 'failure',
                  reason: 'dependency-on-missing-script',
                  script: placeholder,
                  supercedes: failure,
                  diagnostic: {
                    severity: 'error',
                    message: `Cannot find script named ${JSON.stringify(
                      resolved.name,
                    )} in package "${resolved.packageDir}"`,
                    location: {
                      file: packageJson.jsonFile,
                      range: {offset, length},
                    },
                  },
                });
              } else if (failure.reason === 'missing-package-json') {
                // Skip the opening "
                const offset = unresolved.offset + 1;
                // Take everything up to the first colon, but look in
                // the original source, to avoid getting confused by escape
                // sequences, which have a different length before and after
                // encoding.
                const length = packageJson.jsonFile.contents
                  .slice(offset)
                  .indexOf(':');
                const range = {offset, length};
                placeholder.failures.push({
                  type: 'failure',
                  reason: 'dependency-on-missing-package-json',
                  script: placeholder,
                  supercedes: failure,
                  diagnostic: {
                    severity: 'error',
                    message: `package.json file missing: "${pathlib.join(
                      resolved.packageDir,
                      'package.json',
                    )}"`,
                    location: {file: packageJson.jsonFile, range},
                  },
                });
              }
            }
            return undefined;
          })(),
        );
      }
    }
    return {dependencies, encounteredError};
  }

  #processAllowUsuallyExcludedPaths(
    placeholder: UnvalidatedConfig,
    packageJson: PackageJson,
    syntaxInfo: ScriptSyntaxInfo,
  ): boolean {
    const defaultValue = false;
    if (syntaxInfo.wireitConfigNode == null) {
      return defaultValue;
    }
    const node = findNodeAtLocation(syntaxInfo.wireitConfigNode, [
      'allowUsuallyExcludedPaths',
    ]);
    if (node === undefined) {
      return defaultValue;
    }
    if (node.value === true || node.value === false) {
      return node.value;
    }
    placeholder.failures.push({
      type: 'failure',
      reason: 'invalid-config-syntax',
      script: placeholder,
      diagnostic: {
        severity: 'error',
        message: `Must be true or false`,
        location: {
          file: packageJson.jsonFile,
          range: {length: node.length, offset: node.offset},
        },
      },
    });
    return defaultValue;
  }

  #processFiles(
    placeholder: UnvalidatedConfig,
    packageJson: PackageJson,
    syntaxInfo: ScriptSyntaxInfo,
    allowUsuallyExcludedPaths: boolean,
  ): undefined | ArrayNode<string> {
    if (syntaxInfo.wireitConfigNode === undefined) {
      return;
    }
    const filesNode = findNodeAtLocation(syntaxInfo.wireitConfigNode, [
      'files',
    ]);
    if (filesNode === undefined) {
      return;
    }
    const values = [];
    const result = failUnlessArray(filesNode, packageJson.jsonFile);
    if (!result.ok) {
      placeholder.failures.push(result.error);
      return;
    }
    const children = filesNode.children ?? [];
    for (const file of children) {
      const result = failUnlessNonBlankString(file, packageJson.jsonFile);
      if (!result.ok) {
        placeholder.failures.push(result.error);
        continue;
      }
      values.push(result.value.value);
    }
    if (!allowUsuallyExcludedPaths && values.length > 0) {
      values.push(...DEFAULT_EXCLUDE_PATHS);
    }
    return {node: filesNode, values};
  }

  #processOutput(
    placeholder: UnvalidatedConfig,
    packageJson: PackageJson,
    syntaxInfo: ScriptSyntaxInfo,
    command: JsonAstNode<string> | undefined,
    allowUsuallyExcludedPaths: boolean,
  ): undefined | ArrayNode<string> {
    if (syntaxInfo.wireitConfigNode === undefined) {
      return;
    }
    const outputNode = findNodeAtLocation(syntaxInfo.wireitConfigNode, [
      'output',
    ]);
    if (outputNode === undefined) {
      return;
    }
    if (command === undefined) {
      placeholder.failures.push({
        type: 'failure',
        reason: 'invalid-config-syntax',
        script: placeholder,
        diagnostic: {
          severity: 'error',
          message: `"output" can only be set if "command" is also set.`,
          location: {
            file: packageJson.jsonFile,
            range: {
              // Highlight the whole `"output": []` part.
              length: (outputNode.parent ?? outputNode).length,
              offset: (outputNode.parent ?? outputNode).offset,
            },
          },
        },
      });
    }
    const values = [];
    const result = failUnlessArray(outputNode, packageJson.jsonFile);
    if (!result.ok) {
      placeholder.failures.push(result.error);
      return;
    }
    const children = outputNode.children ?? [];
    for (const anOutput of children) {
      const result = failUnlessNonBlankString(anOutput, packageJson.jsonFile);
      if (!result.ok) {
        placeholder.failures.push(result.error);
        continue;
      }
      values.push(result.value.value);
    }
    if (!allowUsuallyExcludedPaths && values.length > 0) {
      values.push(...DEFAULT_EXCLUDE_PATHS);
    }
    return {node: outputNode, values};
  }

  #processClean(
    placeholder: UnvalidatedConfig,
    packageJson: PackageJson,
    syntaxInfo: ScriptSyntaxInfo,
  ): boolean | 'if-file-deleted' {
    const defaultValue = true;
    if (syntaxInfo.wireitConfigNode == null) {
      return defaultValue;
    }
    const clean = findNodeAtLocation(syntaxInfo.wireitConfigNode, ['clean']) as
      | undefined
      | JsonAstNode<true | false | 'if-file-deleted'>;
    if (
      clean !== undefined &&
      clean.value !== true &&
      clean.value !== false &&
      clean.value !== 'if-file-deleted'
    ) {
      placeholder.failures.push({
        type: 'failure',
        reason: 'invalid-config-syntax',
        script: placeholder,
        diagnostic: {
          severity: 'error',
          message: `The "clean" property must be either true, false, or "if-file-deleted".`,
          location: {
            file: packageJson.jsonFile,
            range: {length: clean.length, offset: clean.offset},
          },
        },
      });
      return defaultValue;
    }
    return clean?.value ?? defaultValue;
  }

  #processService(
    placeholder: UnvalidatedConfig,
    packageJson: PackageJson,
    syntaxInfo: ScriptSyntaxInfo,
    command: JsonAstNode<string> | undefined,
    output: ArrayNode<string> | undefined,
  ): ServiceConfig | undefined {
    if (syntaxInfo.wireitConfigNode === undefined) {
      return undefined;
    }
    const serviceNode = findNodeAtLocation(syntaxInfo.wireitConfigNode, [
      'service',
    ]);
    if (serviceNode === undefined) {
      return undefined;
    }
    if (serviceNode.value === false) {
      return undefined;
    }
    if (serviceNode.value !== true && serviceNode.type !== 'object') {
      placeholder.failures.push({
        type: 'failure',
        reason: 'invalid-config-syntax',
        script: placeholder,
        diagnostic: {
          severity: 'error',
          message: `The "service" property must be either true, false, or an object.`,
          location: {
            file: packageJson.jsonFile,
            range: {length: serviceNode.length, offset: serviceNode.offset},
          },
        },
      });
      return undefined;
    }

    let lineMatches: RegExp | undefined = undefined;
    if (serviceNode.type === 'object') {
      const waitForNode = findNodeAtLocation(serviceNode, ['readyWhen']);
      if (waitForNode !== undefined) {
        if (waitForNode.type !== 'object') {
          placeholder.failures.push({
            type: 'failure',
            reason: 'invalid-config-syntax',
            script: placeholder,
            diagnostic: {
              severity: 'error',
              message: `Expected an object.`,
              location: {
                file: packageJson.jsonFile,
                range: {length: serviceNode.length, offset: serviceNode.offset},
              },
            },
          });
        } else {
          const lineMatchesNode = findNodeAtLocation(waitForNode, [
            'lineMatches',
          ]);
          if (lineMatchesNode !== undefined) {
            if (lineMatchesNode.type !== 'string') {
              placeholder.failures.push({
                type: 'failure',
                reason: 'invalid-config-syntax',
                script: placeholder,
                diagnostic: {
                  severity: 'error',
                  message: `Expected a string.`,
                  location: {
                    file: packageJson.jsonFile,
                    range: {
                      length: lineMatchesNode.length,
                      offset: lineMatchesNode.offset,
                    },
                  },
                },
              });
            } else {
              try {
                lineMatches = new RegExp(lineMatchesNode.value as string);
              } catch (error) {
                placeholder.failures.push({
                  type: 'failure',
                  reason: 'invalid-config-syntax',
                  script: placeholder,
                  diagnostic: {
                    severity: 'error',
                    message: String(error),
                    location: {
                      file: packageJson.jsonFile,
                      range: {
                        length: lineMatchesNode.length,
                        offset: lineMatchesNode.offset,
                      },
                    },
                  },
                });
              }
            }
          }
        }
      }
    }

    if (command === undefined) {
      placeholder.failures.push({
        type: 'failure',
        reason: 'invalid-config-syntax',
        script: placeholder,
        diagnostic: {
          severity: 'error',
          message: `A "service" script must have a "command".`,
          location: {
            file: packageJson.jsonFile,
            range: {
              length: serviceNode.length,
              offset: serviceNode.offset,
            },
          },
        },
      });
    }

    if (output !== undefined) {
      placeholder.failures.push({
        type: 'failure',
        reason: 'invalid-config-syntax',
        script: placeholder,
        diagnostic: {
          severity: 'error',
          message: `A "service" script cannot have an "output".`,
          location: {
            file: packageJson.jsonFile,
            range: {
              length: output.node.length,
              offset: output.node.offset,
            },
          },
        },
      });
    }

    return {readyWhen: {lineMatches}};
  }

  async #processPackageLocks(
    placeholder: UnvalidatedConfig,
    packageJson: PackageJson,
    syntaxInfo: ScriptSyntaxInfo,
    files: undefined | ArrayNode<string>,
  ): Promise<void> {
    if (syntaxInfo.wireitConfigNode === undefined) {
      return;
    }
    const packageLocksNode = findNodeAtLocation(syntaxInfo.wireitConfigNode, [
      'packageLocks',
    ]);
    let packageLocks: undefined | {node: JsonAstNode; values: string[]};
    if (packageLocksNode !== undefined) {
      const result = failUnlessArray(packageLocksNode, packageJson.jsonFile);
      if (!result.ok) {
        placeholder.failures.push(result.error);
      } else {
        packageLocks = {node: packageLocksNode, values: []};
        const children = packageLocksNode.children ?? [];
        for (const maybeFilename of children) {
          const result = failUnlessNonBlankString(
            maybeFilename,
            packageJson.jsonFile,
          );
          if (!result.ok) {
            placeholder.failures.push(result.error);
            continue;
          }
          const filename = result.value;
          if (filename.value !== pathlib.basename(filename.value)) {
            placeholder.failures.push({
              type: 'failure',
              reason: 'invalid-config-syntax',
              script: placeholder,
              diagnostic: {
                severity: 'error',
                message: `A package lock must be a filename, not a path`,
                location: {
                  file: packageJson.jsonFile,
                  range: {length: filename.length, offset: filename.offset},
                },
              },
            });
            continue;
          }
          packageLocks.values.push(filename.value);
        }
      }
    }
    if (
      // There's no reason to check package locks when "files" is undefined,
      // because scripts will always run in that case anyway.
      files !== undefined &&
      // An explicitly empty "packageLocks" array disables package lock checking
      // entirely.
      packageLocks?.values.length !== 0
    ) {
      const lockfileNames: string[] =
        packageLocks?.values ?? DEFAULT_LOCKFILES[this.#agent];
      // Generate "package-lock.json", "../package-lock.json",
      // "../../package-lock.json" etc. all the way up to the root of the
      // filesystem, because that's how Node package resolution works.
      const depth = placeholder.packageDir.split(pathlib.sep).length;
      const paths = [];
      for (let i = 0; i < depth; i++) {
        // Glob patterns are specified with forward-slash delimiters, even on
        // Windows.
        const prefix = Array(i + 1).join('../');
        for (const lockfileName of lockfileNames) {
          paths.push(prefix + lockfileName);
        }
      }
      // Only add the package locks that currently exist to the list of files
      // for this script. This way, in watch mode we won't create watchers for
      // all parent directories, just in case a package lock file is created at
      // some later time during watch, which is a rare and not especially
      // important event. Creating watchers for all parent directories is
      // potentially expensive, and on Windows will also result in occasional
      // errors.
      const existing = await Promise.all(
        paths.map(async (path) => {
          try {
            await fs.access(pathlib.join(placeholder.packageDir, path));
            return path;
          } catch {
            return undefined;
          }
        }),
      );
      for (const path of existing) {
        if (path !== undefined) {
          files.values.push(path);
        }
      }
    }
  }

  #processEnv(
    placeholder: UnvalidatedConfig,
    packageJson: PackageJson,
    syntaxInfo: ScriptSyntaxInfo,
    command: JsonAstNode<string> | undefined,
  ): Record<string, string> {
    if (syntaxInfo.wireitConfigNode === undefined) {
      return {};
    }
    const envNode = findNodeAtLocation(syntaxInfo.wireitConfigNode, ['env']);
    if (envNode === undefined) {
      return {};
    }
    if (command === undefined) {
      placeholder.failures.push({
        type: 'failure',
        reason: 'invalid-config-syntax',
        script: placeholder,
        diagnostic: {
          severity: 'error',
          message: 'Can\'t set "env" unless "command" is set',
          location: {
            file: packageJson.jsonFile,
            range: {length: envNode.length, offset: envNode.offset},
          },
        },
      });
    }
    if (envNode.type !== 'object') {
      placeholder.failures.push({
        type: 'failure',
        reason: 'invalid-config-syntax',
        script: placeholder,
        diagnostic: {
          severity: 'error',
          message: 'Expected an object',
          location: {
            file: packageJson.jsonFile,
            range: {length: envNode.length, offset: envNode.offset},
          },
        },
      });
    }
    if (envNode.children === undefined) {
      return {};
    }
    const entries: Array<[string, string]> = [];
    for (const propNode of envNode.children) {
      if (propNode.children === undefined || propNode.children.length !== 2) {
        throw new Error(
          'Internal error: expected object JSON node children to be key/val pairs',
        );
      }
      const keyValueResult = failUnlessKeyValue(
        propNode,
        propNode.children,
        packageJson.jsonFile,
      );
      if (!keyValueResult.ok) {
        placeholder.failures.push(keyValueResult.error);
        continue;
      }
      const [key, val] = keyValueResult.value;
      if (key.type !== 'string') {
        throw new Error(
          'Internal error: expected object JSON node child key to be string',
        );
      }
      const keyStr = key.value as string;
      if (val.type === 'string') {
        entries.push([keyStr, val.value as string]);
      } else if (val.type !== 'object') {
        placeholder.failures.push({
          type: 'failure',
          reason: 'invalid-config-syntax',
          script: placeholder,
          diagnostic: {
            severity: 'error',
            message: 'Expected a string or object',
            location: {
              file: packageJson.jsonFile,
              range: {length: val.length, offset: val.offset},
            },
          },
        });
        continue;
      } else {
        const externalNode = findNodeAtLocation(val, ['external']);
        if (externalNode?.value !== true) {
          placeholder.failures.push({
            type: 'failure',
            reason: 'invalid-config-syntax',
            script: placeholder,
            diagnostic: {
              severity: 'error',
              message: 'Expected "external" to be true',
              location: {
                file: packageJson.jsonFile,
                range: {
                  length: (externalNode ?? val).length,
                  offset: (externalNode ?? val).offset,
                },
              },
            },
          });
          continue;
        }
        const defaultNode = findNodeAtLocation(val, ['default']);
        if (defaultNode && defaultNode.type !== 'string') {
          placeholder.failures.push({
            type: 'failure',
            reason: 'invalid-config-syntax',
            script: placeholder,
            diagnostic: {
              severity: 'error',
              message: 'Expected "default" to be a string',
              location: {
                file: packageJson.jsonFile,
                range: {
                  length: (defaultNode ?? val).length,
                  offset: (defaultNode ?? val).offset,
                },
              },
            },
          });
          continue;
        }
        const envValue = process.env[keyStr];
        if (envValue !== undefined) {
          entries.push([keyStr, envValue]);
        } else if (defaultNode) {
          entries.push([keyStr, defaultNode.value as string]);
        }
      }
    }
    // Sort for better fingerprint match rate.
    entries.sort();
    return Object.fromEntries(entries);
  }

  /**
   * This is where we check for cycles in dependencies, but it's also the
   * place where we transform LocallyValidScriptConfigs to ScriptConfigs.
   */
  #checkForCyclesAndSortDependencies(
    config: LocallyValidScriptConfig | ScriptConfig | InvalidScriptConfig,
    trail: Set<ScriptReferenceString>,
    isPersistent: boolean,
  ): Result<ScriptConfig, InvalidScriptConfig> {
    if (config.state === 'valid') {
      // Already validated.
      return {ok: true, value: config};
    } else if (config.state === 'invalid') {
      return {ok: false, error: config};
    }
    let dependencyStillUnvalidated: undefined | UnvalidatedConfig = undefined;
    const trailKey = scriptReferenceToString(config);
    const supplementalLocations: MessageLocation[] = [];
    if (trail.has(trailKey)) {
      // Found a cycle.
      let cycleStart = 0;
      // Trail is in graph traversal order because JavaScript Map iteration
      // order matches insertion order.
      let i = 0;
      for (const visitedKey of trail) {
        if (visitedKey === trailKey) {
          cycleStart = i;
        }
        i++;
      }
      const trailArray = [...trail].map((key) => {
        const placeholderInfo = this.#placeholders.get(key);
        if (placeholderInfo === undefined) {
          throw new Error(
            `Internal error: placeholder not found for ${key} during cycle detection`,
          );
        }
        return placeholderInfo.placeholder;
      });
      trailArray.push(config);
      const cycleEnd = trailArray.length - 1;
      for (let i = cycleStart; i < cycleEnd; i++) {
        const current = trailArray[i]!;
        const next = trailArray[i + 1];
        if (current.state === 'unvalidated') {
          dependencyStillUnvalidated = current;
          continue;
        }
        const nextNode = current.dependencies.find(
          (dep) => dep.config === next,
        );
        // Use the actual value in the array, because this could refer to
        // a script in another package.
        const nextName =
          nextNode?.specifier?.value ??
          next?.name ??
          trailArray[cycleStart]?.name;
        const message =
          next === trailArray[cycleStart]
            ? `${JSON.stringify(current.name)} points back to ${JSON.stringify(
                nextName,
              )}`
            : `${JSON.stringify(current.name)} points to ${JSON.stringify(
                nextName,
              )}`;

        const culpritNode =
          // This should always be present
          nextNode?.specifier ??
          // But failing that, fall back to the best node we have.
          current.configAstNode?.name ??
          current.scriptAstNode!.name;
        supplementalLocations.push({
          message,
          location: {
            file: current.declaringFile,
            range: {
              offset: culpritNode.offset,
              length: culpritNode.length,
            },
          },
        });
      }
      const diagnostic: Diagnostic = {
        severity: 'error',
        message: `Cycle detected in dependencies of ${JSON.stringify(
          config.name,
        )}.`,
        location: {
          file: config.declaringFile,
          range: {
            length:
              config.configAstNode?.name.length ??
              config.scriptAstNode!.name.length,
            offset:
              config.configAstNode?.name.offset ??
              config.scriptAstNode!.name.length,
          },
        },
        supplementalLocations,
      };
      const failure: Cycle = {
        type: 'failure',
        reason: 'cycle',
        script: config,
        diagnostic,
      };
      return {ok: false, error: this.#markAsInvalid(config, failure)};
    }
    if (config.dependencies.length > 0) {
      // Sorting means that if the user re-orders the same set of dependencies,
      // the trail we take in this walk remains the same, so any cycle error
      // message we might throw will have the same trail, too. This also helps
      // make the caching keys that we'll be generating in the later execution
      // step insensitive to dependency order as well.
      config.dependencies.sort((a, b) => {
        if (a.config.packageDir !== b.config.packageDir) {
          return a.config.packageDir.localeCompare(b.config.packageDir);
        }
        return a.config.name.localeCompare(b.config.name);
      });
      trail.add(trailKey);
      for (const dependency of config.dependencies) {
        if (dependency.config.state === 'unvalidated') {
          dependencyStillUnvalidated = dependency.config;
          continue;
        }
        const validDependencyConfigResult =
          this.#checkForCyclesAndSortDependencies(
            dependency.config,
            trail,
            // Walk through no-command scripts and services when determining if
            // something is persistent.
            isPersistent &&
              (config.command === undefined || config.service !== undefined),
          );
        if (!validDependencyConfigResult.ok) {
          return {
            ok: false,
            error: this.#markAsInvalid(
              config,
              validDependencyConfigResult.error.dependencyFailure,
            ),
          };
        }
        const validDependencyConfig = validDependencyConfigResult.value;
        if (validDependencyConfig.service !== undefined) {
          // We directly depend on a service.
          config.services.push(validDependencyConfig);
        } else if (validDependencyConfig.command === undefined) {
          // We depend on a no-command script, so in effect we depend on all of
          // the services it depends on.
          for (const service of validDependencyConfig.services) {
            config.services.push(service);
          }
        }
      }
      trail.delete(trailKey);
    }
    if (dependencyStillUnvalidated !== undefined) {
      // At least one of our dependencies was unvalidated, likely because it
      // had a syntax error or was missing necessary information. Therefore
      // we can't transition to valid either.
      const failure: Failure = {
        type: 'failure',
        reason: 'dependency-invalid',
        script: config,
        dependency: dependencyStillUnvalidated,
      };
      return {ok: false, error: this.#markAsInvalid(config, failure)};
    }

    let validConfig: ScriptConfig;
    if (config.service !== undefined) {
      // We should already have created an invalid script at this point, so we
      // should never get here. We throw here to convince TypeScript that this
      // is guaranteed.
      if (config.command === undefined) {
        throw new Error(
          'Internal error: Supposedly valid service did not have command',
        );
      }
      validConfig = {
        ...config,
        state: 'valid',
        extraArgs: undefined,
        dependencies: config.dependencies as Array<Dependency<ScriptConfig>>,
        // Unfortunately TypeScript doesn't narrow the ...config spread, so we
        // have to assign explicitly.
        command: config.command,
        isPersistent,
        serviceConsumers: [],
      };
    } else {
      validConfig = {
        ...config,
        state: 'valid',
        extraArgs: undefined,
        dependencies: config.dependencies as Array<Dependency<ScriptConfig>>,
        // Unfortunately TypeScript doesn't narrow the ...config spread, so we
        // have to assign explicitly.
        service: config.service,
      };
    }

    // Propagate reverse service dependencies.
    if (validConfig.command) {
      for (const dependency of validConfig.dependencies) {
        if (dependency.config.service !== undefined) {
          dependency.config.serviceConsumers.push(validConfig);
        } else if (dependency.config.command === undefined) {
          for (const service of dependency.config.services) {
            service.serviceConsumers.push(validConfig);
          }
        }
      }
    }

    // We want to keep the original reference, but get type checking that
    // the only difference between a ScriptConfig and a
    // LocallyValidScriptConfig is that the state is 'valid' and the
    // dependencies are also valid, which we confirmed above.
    Object.assign(config, validConfig);

    return {ok: true, value: config as unknown as ScriptConfig};
  }

  #markAsInvalid(
    config: LocallyValidScriptConfig,
    failure: Failure,
  ): InvalidScriptConfig {
    const invalidConfig: InvalidScriptConfig = {
      ...config,
      state: 'invalid',
      dependencyFailure: failure,
    };
    Object.assign(config, invalidConfig);
    config.failures.push(failure);
    return config as unknown as InvalidScriptConfig;
  }

  /**
   * Resolve a dependency string specified in a "wireit.<script>.dependencies"
   * array into concrete packages and script names.
   *
   * Note this can return 0, 1, or >1 script references.
   */
  async #resolveDependency(
    packageJson: PackageJson,
    contextScript: ScriptReference,
    dependencySpecifier: JsonAstNode<string>,
  ): Promise<Result<Array<ScriptReference>, Failure>> {
    const parsed = parseDependency(dependencySpecifier.value);
    if (!parsed.ok) {
      return {
        ok: false,
        error: {
          type: 'failure',
          reason: 'invalid-config-syntax',
          script: contextScript,
          diagnostic: {
            ...parsed.error,
            location: {
              // The parser doesn't know about the file, add that to the
              // diagnostic.
              file: packageJson.jsonFile,
              range: {
                offset:
                  dependencySpecifier.offset +
                  1 +
                  parsed.error.location.range.offset,
                length: parsed.error.location.range.length,
              },
            },
          },
        },
      };
    }

    const {
      package: parsedPackage,
      script: parsedScript,
      inverted,
    } = parsed.value;

    if (inverted) {
      // TODO(aomarks) Support inversion.
      return invalidSyntaxError(
        'Dependency inversion operator "!" is not yet supported',
        contextScript,
        packageJson.jsonFile,
        {offset: dependencySpecifier.offset, length: 1},
      );
    }

    const scriptName = this.#resolveScriptName(parsedScript, contextScript);
    if (!scriptName.ok) {
      return scriptName;
    }

    const packageDirs = await this.#resolvePackageDirs(
      contextScript,
      packageJson,
      dependencySpecifier,
      parsedPackage,
    );
    if (!packageDirs.ok) {
      return packageDirs;
    }

    return {
      ok: true,
      value: packageDirs.value.map((packageDir) => ({
        packageDir,
        name: scriptName.value,
      })),
    };
  }

  #resolveScriptName(
    script: ParsedScriptWithRange,
    context: ScriptReference,
  ): Result<string, Failure> {
    if (script.kind === 'name') {
      return {ok: true, value: script.name};
    }
    if (script.kind === 'this') {
      return {ok: true, value: context.name};
    }
    script satisfies never;
    throw new Error(
      `Unexpected parsed script format: ${JSON.stringify(script)}`,
    );
  }

  async #resolvePackageDirs(
    contextScript: ScriptReference,
    packageJson: PackageJson,
    dependencySpecifier: JsonAstNode<string>,
    parsedPackage: ParsedPackageWithRange,
  ): Promise<Result<string[], Failure>> {
    if (parsedPackage.kind === 'this') {
      return {ok: true, value: [contextScript.packageDir]};
    }
    if (parsedPackage.kind === 'path') {
      return this.#resolvePathPackage(
        packageJson,
        contextScript,
        dependencySpecifier,
        parsedPackage,
      );
    }
    if (parsedPackage.kind === 'npm') {
      return await this.#resolveNpmPackage(
        packageJson,
        contextScript,
        dependencySpecifier,
        parsedPackage,
      );
    }
    if (parsedPackage.kind === 'dependencies') {
      return await this.#resolveNpmDependencyPackages(
        packageJson,
        contextScript,
        dependencySpecifier,
        parsedPackage,
      );
    }
    if (parsedPackage.kind === 'workspaces') {
      return await this.#resolveWorkspacesPackages(
        packageJson,
        contextScript,
        dependencySpecifier,
        parsedPackage,
      );
    }
    parsedPackage satisfies never;
    throw new Error(
      `Unexpected parsed package format: ${JSON.stringify(parsedPackage)}`,
    );
  }

  #resolvePathPackage(
    packageJson: PackageJson,
    contextScript: ScriptReference,
    dependencySpecifier: JsonAstNode<string>,
    parsedPackage: ParsedPackageWithRange & PackagePath,
  ): Result<string[], Failure> {
    const absolute = pathlib.resolve(
      contextScript.packageDir,
      parsedPackage.path,
    );
    if (absolute === contextScript.packageDir) {
      return invalidSyntaxError(
        `Cross-package dependency "${dependencySpecifier.value}" ` +
          `resolved to the same package.`,
        contextScript,
        packageJson.jsonFile,
        {
          offset: dependencySpecifier.offset + 1 + parsedPackage.range.offset,
          length: parsedPackage.range.length,
        },
      );
    }
    return {ok: true, value: [absolute]};
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async #resolveNpmPackage(
    packageJson: PackageJson,
    contextScript: ScriptReference,
    dependencySpecifier: JsonAstNode<string>,
    parsedPackage: ParsedPackageWithRange,
  ): Promise<Result<string[], Failure>> {
    // TODO(aomarks) Support "dependencies".
    return invalidSyntaxError(
      'NPM packages are not yet supported',
      contextScript,
      packageJson.jsonFile,
      {
        offset: dependencySpecifier.offset + 1 + parsedPackage.range.offset,
        length: parsedPackage.range.length,
      },
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async #resolveNpmDependencyPackages(
    packageJson: PackageJson,
    contextScript: ScriptReference,
    dependencySpecifier: JsonAstNode<string>,
    parsedPackage: ParsedPackageWithRange,
  ): Promise<Result<string[], Failure>> {
    // TODO(aomarks) Support "dependencies".
    return invalidSyntaxError(
      `"dependencies" is not yet supported`,
      contextScript,
      packageJson.jsonFile,
      {
        offset: dependencySpecifier.offset + 1 + parsedPackage.range.offset,
        length: parsedPackage.range.length,
      },
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async #resolveWorkspacesPackages(
    packageJson: PackageJson,
    contextScript: ScriptReference,
    dependencySpecifier: JsonAstNode<string>,
    parsedPackage: ParsedPackageWithRange,
  ): Promise<Result<string[], Failure>> {
    // TODO(aomarks) Support "workspacess".
    return invalidSyntaxError(
      `"workspaces" is not yet supported`,
      contextScript,
      packageJson.jsonFile,
      {
        offset: dependencySpecifier.offset + 1 + parsedPackage.range.offset,
        length: parsedPackage.range.length,
      },
    );
  }
}

/**
 * Return a failing result if the given value is not a string, or is an empty
 * string.
 */
export function failUnlessNonBlankString(
  astNode: NamedAstNode,
  file: JsonFile,
): Result<NamedAstNode<string>, Failure>;
export function failUnlessNonBlankString(
  astNode: JsonAstNode,
  file: JsonFile,
): Result<JsonAstNode<string>, Failure>;
export function failUnlessNonBlankString(
  astNode: JsonAstNode,
  file: JsonFile,
): Result<JsonAstNode<string>, Failure> {
  if (astNode.type !== 'string') {
    return {
      ok: false,
      error: {
        type: 'failure',
        reason: 'invalid-config-syntax',
        script: {packageDir: pathlib.dirname(file.path)},
        diagnostic: {
          severity: 'error',
          message: `Expected a string, but was ${astNode.type}.`,
          location: {
            file,
            range: {
              offset: astNode.offset,
              length: astNode.length,
            },
          },
        },
      },
    };
  }
  if ((astNode.value as string).match(/^\s*$/)) {
    return {
      ok: false,
      error: {
        type: 'failure',
        reason: 'invalid-config-syntax',
        script: {packageDir: pathlib.dirname(file.path)},
        diagnostic: {
          severity: 'error',
          message: `Expected this field to be nonempty`,
          location: {
            file,
            range: {
              offset: astNode.offset,
              length: astNode.length,
            },
          },
        },
      },
    };
  }
  return {ok: true, value: astNode as JsonAstNode<string>};
}

/**
 * Return a failing result if the given value is not an Array.
 */
const failUnlessArray = (
  astNode: JsonAstNode,
  file: JsonFile,
): Result<void, Failure> => {
  if (astNode.type !== 'array') {
    return {
      ok: false,
      error: {
        type: 'failure',
        reason: 'invalid-config-syntax',
        script: {packageDir: pathlib.dirname(file.path)},
        diagnostic: {
          severity: 'error',
          message: `Expected an array, but was ${astNode.type}.`,
          location: {
            file: file,
            range: {
              offset: astNode.offset,
              length: astNode.length,
            },
          },
        },
      },
    };
  }
  return {ok: true, value: undefined};
};

/**
 * Return a failed result if the given value is not an object literal ({...}).
 */
export const failUnlessJsonObject = (
  astNode: JsonAstNode,
  file: JsonFile,
): Failure | undefined => {
  if (astNode.type !== 'object') {
    return {
      type: 'failure',
      reason: 'invalid-config-syntax',
      script: {packageDir: pathlib.dirname(file.path)},
      diagnostic: {
        severity: 'error',
        message: `Expected an object, but was ${astNode.type}.`,
        location: {
          file: file,
          range: {
            offset: astNode.offset,
            length: astNode.length,
          },
        },
      },
    };
  }
};

export const failUnlessKeyValue = (
  node: JsonAstNode,
  children: Array<JsonAstNode>,
  file: JsonFile,
): Result<[JsonAstNode, JsonAstNode]> => {
  const [rawName, rawValue] = children;
  if (
    children.length !== 2 ||
    rawName === undefined ||
    rawValue === undefined
  ) {
    return {
      ok: false,
      error: {
        type: 'failure',
        reason: 'invalid-config-syntax',
        script: {packageDir: pathlib.dirname(file.path)},
        diagnostic: {
          severity: 'error',
          message: `Expected "key": "value"`,
          location: {
            file,
            range: {
              offset: node.offset,
              length: node.length,
            },
          },
        },
      },
    };
  }
  return {ok: true, value: [rawName, rawValue]};
};

const invalidSyntaxError = (
  message: string,
  script: ScriptReference,
  file: JsonFile,
  range: Range,
): {ok: false; error: InvalidConfigSyntax} => ({
  ok: false,
  error: {
    type: 'failure',
    reason: 'invalid-config-syntax',
    script,
    diagnostic: {
      message,
      severity: 'error',
      location: {file, range},
    },
  },
});
