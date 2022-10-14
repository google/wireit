/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import {
  CachingPackageJsonReader,
  FileSystem,
} from './util/package-json-reader.js';
import {Dependency, scriptReferenceToString} from './config.js';
import {findNodeAtLocation, JsonFile} from './util/ast.js';

import type {ArrayNode, JsonAstNode, NamedAstNode} from './util/ast.js';
import type {Diagnostic, MessageLocation, Result} from './error.js';
import type {Cycle, DependencyOnMissingPackageJson, Failure} from './event.js';
import type {PackageJson, ScriptSyntaxInfo} from './util/package-json.js';
import type {
  ScriptConfig,
  ScriptReference,
  ScriptReferenceString,
} from './config.js';

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
 * Analyzes and validates a script along with all of its transitive
 * dependencies, producing a build graph that is ready to be executed.
 */
export class Analyzer {
  private readonly _packageJsonReader;
  private readonly _placeholders = new Map<
    ScriptReferenceString,
    PlaceholderInfo
  >();
  private readonly _ongoingWorkPromises: Array<Promise<undefined>> = [];
  private readonly _relevantConfigFilePaths = new Set<string>();

  constructor(filesystem?: FileSystem) {
    this._packageJsonReader = new CachingPackageJsonReader(filesystem);
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
          this._getPlaceholder({name: script.name, packageDir});
        }
      })
    );
    await this._waitForAnalysisToComplete();
    // Check for cycles.
    for (const info of this._placeholders.values()) {
      if (info.placeholder.state === 'unvalidated') {
        continue;
      }
      // We don't care about the result, if there's a cycle error it'll
      // be added to the scripts' diagnostics.
      this._checkForCyclesAndSortDependencies(info.placeholder, new Set());
    }

    return this._getDiagnostics();
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
    extraArgs: string[] | undefined
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
    const rootPlaceholder = this._getPlaceholder(root);

    // Note we can't use Promise.all here, because new promises can be added to
    // the promises array as long as any promise is pending.
    await this._waitForAnalysisToComplete();
    {
      const errors = await this._getDiagnostics();
      if (errors.size > 0) {
        return {
          config: {ok: false, error: [...errors]},
          relevantConfigFilePaths: this._relevantConfigFilePaths,
        };
      }
    }

    // We can safely assume all placeholders have now been upgraded to full
    // configs.
    const rootConfig = rootPlaceholder.placeholder;
    if (rootConfig.state === 'unvalidated') {
      throw new Error(
        `Internal error: script ${root.name} in ${root.packageDir} is still unvalidated but had no failures`
      );
    }
    const cycleResult = this._checkForCyclesAndSortDependencies(
      rootConfig,
      new Set()
    );
    if (!cycleResult.ok) {
      return {
        config: {ok: false, error: [cycleResult.error.dependencyFailure]},
        relevantConfigFilePaths: this._relevantConfigFilePaths,
      };
    }
    const validRootConfig = cycleResult.value;
    validRootConfig.extraArgs = extraArgs;
    return {
      config: {ok: true, value: validRootConfig},
      relevantConfigFilePaths: this._relevantConfigFilePaths,
    };
  }

  async analyzeIgnoringErrors(
    scriptReference: ScriptReference
  ): Promise<PotentiallyValidScriptConfig> {
    await this.analyze(scriptReference, []);
    return this._getPlaceholder(scriptReference).placeholder;
  }

  private async _getDiagnostics(): Promise<Set<Failure>> {
    const failures = new Set<Failure>();
    for await (const failure of this._packageJsonReader.getFailures()) {
      failures.add(failure);
    }
    for (const info of this._placeholders.values()) {
      for (const failure of info.placeholder.failures) {
        failures.add(failure);
      }
    }
    for (const failure of failures) {
      const supercedes = (failure as Partial<DependencyOnMissingPackageJson>)
        .supercedes;
      if (supercedes != null) {
        failures.delete(supercedes);
      }
    }
    return failures;
  }

  private async _waitForAnalysisToComplete() {
    while (this._ongoingWorkPromises.length > 0) {
      const promise =
        this._ongoingWorkPromises[this._ongoingWorkPromises.length - 1];
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
        this._ongoingWorkPromises[this._ongoingWorkPromises.length - 1]
      ) {
        void this._ongoingWorkPromises.pop();
      }
    }
  }

  async getPackageJson(packageDir: string): Promise<Result<PackageJson>> {
    this._relevantConfigFilePaths.add(pathlib.join(packageDir, 'package.json'));
    return this._packageJsonReader.read(packageDir);
  }

  /**
   * Create or return a cached placeholder script configuration object for the
   * given script reference.
   */
  private _getPlaceholder(reference: ScriptReference): PlaceholderInfo {
    const scriptKey = scriptReferenceToString(reference);
    let placeholderInfo = this._placeholders.get(scriptKey);
    if (placeholderInfo === undefined) {
      const placeholder: UnvalidatedConfig = {
        ...reference,
        state: 'unvalidated',
        failures: [],
      };
      placeholderInfo = {
        placeholder: placeholder,
        upgradeComplete: this._upgradePlaceholder(placeholder),
      };
      this._placeholders.set(scriptKey, placeholderInfo);
      this._ongoingWorkPromises.push(placeholderInfo.upgradeComplete);
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
  private async _upgradePlaceholder(
    placeholder: UnvalidatedConfig
  ): Promise<undefined> {
    const packageJsonResult = await this.getPackageJson(placeholder.packageDir);
    if (!packageJsonResult.ok) {
      placeholder.failures.push(packageJsonResult.error);
      return undefined;
    }
    const packageJson = packageJsonResult.value;
    placeholder.failures.push(...packageJson.failures);

    const syntaxInfo = packageJson.getScriptInfo(placeholder.name);
    if (syntaxInfo === undefined || syntaxInfo.scriptNode === undefined) {
      let node;
      let reason;
      if (syntaxInfo?.wireitConfigNode?.name != null) {
        node = syntaxInfo.wireitConfigNode.name;
        reason = 'wireit-config-but-no-script' as const;
      } else {
        node ??= packageJson.scriptsSection?.name;
        reason = 'script-not-found' as const;
      }
      const range = node
        ? {offset: node.offset, length: node.length}
        : {offset: 0, length: 0};
      placeholder.failures.push({
        type: 'failure',
        reason,
        script: placeholder,
        diagnostic: {
          severity: 'error',
          message: `Script "${placeholder.name}" not found in the scripts section of this package.json.`,
          location: {file: packageJson.jsonFile, range},
        },
      });
      return undefined;
    }
    const scriptCommand = syntaxInfo.scriptNode;
    const wireitConfig = syntaxInfo.wireitConfigNode;

    if (
      wireitConfig !== undefined &&
      scriptCommand.value !== 'wireit' &&
      scriptCommand.value !== 'yarn run -TB wireit'
    ) {
      const configName = wireitConfig.name;
      placeholder.failures.push({
        type: 'failure',
        reason: 'script-not-wireit',
        script: placeholder,
        diagnostic: {
          message: `This command should just be "wireit", as this script is configured in the wireit section.`,
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

    if (wireitConfig === undefined && scriptCommand.value === 'wireit') {
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

    const {dependencies, encounteredError: dependenciesErrored} =
      this._processDependencies(placeholder, packageJson, syntaxInfo);

    let command: JsonAstNode<string> | undefined;
    let commandError = false;
    if (wireitConfig === undefined) {
      const result = failUnlessNonBlankString(
        scriptCommand,
        packageJson.jsonFile
      );
      if (result.ok) {
        command = result.value;
      } else {
        commandError = true;
        placeholder.failures.push(result.error);
      }
    } else {
      const commandAst = findNodeAtLocation(wireitConfig, ['command']) as
        | undefined
        | JsonAstNode<string>;
      if (commandAst !== undefined) {
        const result = failUnlessNonBlankString(
          commandAst,
          packageJson.jsonFile
        );
        if (result.ok) {
          command = result.value;
        } else {
          commandError = true;
          placeholder.failures.push(result.error);
        }
      }
    }

    const files = this._processFiles(placeholder, packageJson, syntaxInfo);

    if (
      wireitConfig !== undefined &&
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

    const output = this._processOutput(
      placeholder,
      packageJson,
      syntaxInfo,
      command
    );
    const clean = this._processClean(placeholder, packageJson, syntaxInfo);
    const service = this._processService(
      placeholder,
      packageJson,
      syntaxInfo,
      command,
      output
    );
    this._processPackageLocks(placeholder, packageJson, syntaxInfo, files);

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
    };
    Object.assign(placeholder, remainingConfig);
  }

  private _processDependencies(
    placeholder: UnvalidatedConfig,
    packageJson: PackageJson,
    scriptInfo: ScriptSyntaxInfo
  ): {
    dependencies: Array<Dependency<PotentiallyValidScriptConfig>>;
    encounteredError: boolean;
  } {
    const dependencies: Array<Dependency<PotentiallyValidScriptConfig>> = [];
    const dependenciesAst =
      scriptInfo.wireitConfigNode &&
      findNodeAtLocation(scriptInfo.wireitConfigNode, ['dependencies']);
    let encounteredError = false;
    if (dependenciesAst == null) {
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
    for (let i = 0; i < children.length; i++) {
      const maybeUnresolved = children[i];
      const stringResult = failUnlessNonBlankString(
        maybeUnresolved,
        packageJson.jsonFile
      );
      if (!stringResult.ok) {
        encounteredError = true;
        placeholder.failures.push(stringResult.error);
        continue;
      }
      const unresolved = stringResult.value;
      const result = this._resolveDependency(
        unresolved,
        placeholder,
        packageJson.jsonFile
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
        const placeHolderInfo = this._getPlaceholder(resolved);
        dependencies.push({
          astNode: unresolved,
          config: placeHolderInfo.placeholder,
        });
        this._ongoingWorkPromises.push(
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
                      resolved.name
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
                      'package.json'
                    )}"`,
                    location: {file: packageJson.jsonFile, range},
                  },
                });
              }
            }
            return undefined;
          })()
        );
      }
    }
    return {dependencies, encounteredError};
  }

  private _processFiles(
    placeholder: UnvalidatedConfig,
    packageJson: PackageJson,
    syntaxInfo: ScriptSyntaxInfo
  ): undefined | ArrayNode<string> {
    if (syntaxInfo.wireitConfigNode == null) {
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
    for (let i = 0; i < children.length; i++) {
      const file = children[i];
      const result = failUnlessNonBlankString(file, packageJson.jsonFile);
      if (!result.ok) {
        placeholder.failures.push(result.error);
        continue;
      }
      values.push(result.value.value);
    }
    return {node: filesNode, values};
  }

  private _processOutput(
    placeholder: UnvalidatedConfig,
    packageJson: PackageJson,
    syntaxInfo: ScriptSyntaxInfo,
    command: JsonAstNode<string> | undefined
  ): undefined | ArrayNode<string> {
    if (syntaxInfo.wireitConfigNode == null) {
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
    for (let i = 0; i < children.length; i++) {
      const anOutput = children[i];
      const result = failUnlessNonBlankString(anOutput, packageJson.jsonFile);
      if (!result.ok) {
        placeholder.failures.push(result.error);
        continue;
      }
      values.push(result.value.value);
    }
    return {node: outputNode, values};
  }

  private _processClean(
    placeholder: UnvalidatedConfig,
    packageJson: PackageJson,
    syntaxInfo: ScriptSyntaxInfo
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

  private _processService(
    placeholder: UnvalidatedConfig,
    packageJson: PackageJson,
    syntaxInfo: ScriptSyntaxInfo,
    command: JsonAstNode<string> | undefined,
    output: ArrayNode<string> | undefined
  ): boolean {
    const defaultValue = false;
    if (syntaxInfo.wireitConfigNode == null) {
      return defaultValue;
    }
    const node = findNodeAtLocation(syntaxInfo.wireitConfigNode, [
      'service',
    ]) as undefined | JsonAstNode<true | false>;
    if (node == null) {
      return defaultValue;
    }
    if (node.value !== true && node.value !== false) {
      placeholder.failures.push({
        type: 'failure',
        reason: 'invalid-config-syntax',
        script: placeholder,
        diagnostic: {
          severity: 'error',
          message: `The "service" property must be either true or false.`,
          location: {
            file: packageJson.jsonFile,
            range: {length: node.length, offset: node.offset},
          },
        },
      });
      return defaultValue;
    }

    const value = node?.value ?? defaultValue;

    if (value === true && command == null) {
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
              length: node.length,
              offset: node.offset,
            },
          },
        },
      });
    }

    if (value === true && output != null) {
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

    return value;
  }

  private _processPackageLocks(
    placeholder: UnvalidatedConfig,
    packageJson: PackageJson,
    syntaxInfo: ScriptSyntaxInfo,
    files: undefined | ArrayNode<string>
  ): void {
    if (syntaxInfo.wireitConfigNode == null) {
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
        for (let i = 0; i < children.length; i++) {
          const maybeFilename = children[i];
          const result = failUnlessNonBlankString(
            maybeFilename,
            packageJson.jsonFile
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
      const lockfileNames = packageLocks?.values ?? ['package-lock.json'];
      // Generate "package-lock.json", "../package-lock.json",
      // "../../package-lock.json" etc. all the way up to the root of the
      // filesystem, because that's how Node package resolution works.
      const depth = placeholder.packageDir.split(pathlib.sep).length;
      for (let i = 0; i < depth; i++) {
        // Glob patterns are specified with forward-slash delimiters, even on
        // Windows.
        const prefix = Array(i + 1).join('../');
        for (const lockfileName of lockfileNames) {
          files.values.push(prefix + lockfileName);
        }
      }
    }
  }

  /**
   * This is where we check for cycles in dependencies, but it's also the
   * place where we transform LocallyValidScriptConfigs to ScriptConfigs.
   */
  private _checkForCyclesAndSortDependencies(
    config: LocallyValidScriptConfig | ScriptConfig | InvalidScriptConfig,
    trail: Set<ScriptReferenceString>
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
        const placeholderInfo = this._placeholders.get(key);
        if (placeholderInfo == null) {
          throw new Error(
            `Internal error: placeholder not found for ${key} during cycle detection`
          );
        }
        return placeholderInfo.placeholder;
      });
      trailArray.push(config);
      const cycleEnd = trailArray.length - 1;
      for (let i = cycleStart; i < cycleEnd; i++) {
        const current = trailArray[i];
        const next = trailArray[i + 1];
        if (current.state === 'unvalidated') {
          dependencyStillUnvalidated = current;
          continue;
        }
        const nextNode = current.dependencies.find(
          (dep) => dep.config === next
        );
        // Use the actual value in the array, because this could refer to
        // a script in another package.
        const nextName =
          nextNode?.astNode?.value ?? next?.name ?? trailArray[cycleStart].name;
        const message =
          next === trailArray[cycleStart]
            ? `${JSON.stringify(current.name)} points back to ${JSON.stringify(
                nextName
              )}`
            : `${JSON.stringify(current.name)} points to ${JSON.stringify(
                nextName
              )}`;

        const culpritNode =
          // This should always be present
          nextNode?.astNode ??
          // But failing that, fall back to the best node we have.
          current.configAstNode?.name ??
          current.scriptAstNode?.name;
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
          config.name
        )}.`,
        location: {
          file: config.declaringFile,
          range: {
            length:
              config.configAstNode?.name.length ??
              config.scriptAstNode?.name.length,
            offset:
              config.configAstNode?.name.offset ??
              config.scriptAstNode?.name.length,
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
      return {ok: false, error: this._markAsInvalid(config, failure)};
    }
    if (config.dependencies != null && config.dependencies.length > 0) {
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
        const result = this._checkForCyclesAndSortDependencies(
          dependency.config,
          trail
        );
        if (!result.ok) {
          return {
            ok: false,
            error: this._markAsInvalid(config, result.error.dependencyFailure),
          };
        }
      }
      trail.delete(trailKey);
    }
    if (dependencyStillUnvalidated != null) {
      // At least one of our dependencies was unvalidated, likely because it
      // had a syntax error or was missing necessary information. Therefore
      // we can't transition to valid either.
      const failure: Failure = {
        type: 'failure',
        reason: 'dependency-invalid',
        script: config,
        dependency: dependencyStillUnvalidated,
      };
      return {ok: false, error: this._markAsInvalid(config, failure)};
    }
    {
      const validConfig: ScriptConfig = {
        ...config,
        extraArgs: undefined,
        state: 'valid',
        dependencies: config.dependencies as Array<Dependency<ScriptConfig>>,
      };
      // We want to keep the original reference, but get type checking that
      // the only difference between a ScriptConfig and a
      // LocallyValidScriptConfig is that the state is 'valid' and the
      // dependencies are also valid, which we confirmed above.
      Object.assign(config, validConfig);
    }
    return {ok: true, value: config as unknown as ScriptConfig};
  }

  private _markAsInvalid(
    config: LocallyValidScriptConfig,
    failure: Failure
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
   * array, which may contain special syntax like relative paths or
   * "$WORKSPACES", into concrete packages and script names.
   *
   * Note this can return 0, 1, or >1 script references.
   */
  private _resolveDependency(
    dependency: JsonAstNode<string>,
    context: ScriptReference,
    referencingFile: JsonFile
  ): Result<Array<ScriptReference>, Failure> {
    // TODO(aomarks) Implement $WORKSPACES syntax.
    if (dependency.value.startsWith('.')) {
      // TODO(aomarks) It is technically valid for an npm script to start with a
      // ".". We should support that edge case with backslash escaping.
      const result = this._resolveCrossPackageDependency(
        dependency,
        context,
        referencingFile
      );
      if (!result.ok) {
        return result;
      }
      return {ok: true, value: [result.value]};
    }
    return {
      ok: true,
      value: [{packageDir: context.packageDir, name: dependency.value}],
    };
  }

  /**
   * Resolve a cross-package dependency (e.g. "../other-package:build").
   * Cross-package dependencies always start with a ".".
   */
  private _resolveCrossPackageDependency(
    dependency: JsonAstNode<string>,
    context: ScriptReference,
    referencingFile: JsonFile
  ): Result<ScriptReference, Failure> {
    // TODO(aomarks) On some file systems, it is valid to have a ":" in a file
    // path. We should support that edge case with backslash escaping.
    const firstColonIdx = dependency.value.indexOf(':');
    if (firstColonIdx === -1) {
      return {
        ok: false,
        error: {
          type: 'failure',
          reason: 'invalid-config-syntax',
          script: context,
          diagnostic: {
            severity: 'error',
            message:
              `Cross-package dependency must use syntax ` +
              `"<relative-path>:<script-name>", ` +
              `but there's no ":" character in "${dependency.value}".`,
            location: {
              file: referencingFile,
              range: {offset: dependency.offset, length: dependency.length},
            },
          },
        },
      };
    }
    const scriptName = dependency.value.slice(firstColonIdx + 1);
    if (!scriptName) {
      return {
        ok: false,
        error: {
          type: 'failure',
          reason: 'invalid-config-syntax',
          script: context,
          diagnostic: {
            severity: 'error',
            message:
              `Cross-package dependency must use syntax ` +
              `"<relative-path>:<script-name>", ` +
              `but there's no script name in "${dependency.value}".`,
            location: {
              file: referencingFile,
              range: {offset: dependency.offset, length: dependency.length},
            },
          },
        },
      };
    }
    const relativePackageDir = dependency.value.slice(0, firstColonIdx);
    const absolutePackageDir = pathlib.resolve(
      context.packageDir,
      relativePackageDir
    );
    if (absolutePackageDir === context.packageDir) {
      return {
        ok: false,
        error: {
          type: 'failure',
          reason: 'invalid-config-syntax',
          script: context,
          diagnostic: {
            severity: 'error',
            message:
              `Cross-package dependency "${dependency.value}" ` +
              `resolved to the same package.`,
            location: {
              file: referencingFile,
              range: {offset: dependency.offset, length: dependency.length},
            },
          },
        },
      };
    }
    return {
      ok: true,
      value: {packageDir: absolutePackageDir, name: scriptName},
    };
  }
}

/**
 * Return a failing result if the given value is not a string, or is an empty
 * string.
 */
export function failUnlessNonBlankString(
  astNode: NamedAstNode,
  file: JsonFile
): Result<NamedAstNode<string>, Failure>;
export function failUnlessNonBlankString(
  astNode: JsonAstNode,
  file: JsonFile
): Result<JsonAstNode<string>, Failure>;
export function failUnlessNonBlankString(
  astNode: JsonAstNode,
  file: JsonFile
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
  file: JsonFile
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
  file: JsonFile
): Failure | void => {
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
