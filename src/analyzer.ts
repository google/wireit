/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import {Diagnostic, MessageLocation, Result} from './error.js';
import {CachingPackageJsonReader} from './util/package-json-reader.js';
import {scriptReferenceToString} from './script.js';
import {findNodeAtLocation, JsonFile} from './util/ast.js';

import type {
  ScriptConfig,
  ScriptReference,
  ScriptReferenceString,
} from './script.js';
import type {ArrayNode, JsonAstNode, NamedAstNode} from './util/ast.js';
import {DependencyOnMissingPackageJson, Failure} from './event.js';
import {PackageJson} from './util/package-json.js';

/**
 * A {@link ScriptConfig} where all fields are optional apart from `packageDir`
 * and `name`, used temporarily while package.json files are still loading.
 */
export type PlaceholderConfig = ScriptReference & Partial<ScriptConfig>;

interface PlaceholderInfo {
  placeholder: PlaceholderConfig;
  resolutionPromise: Promise<Result<void, Failure[]>>;
}

/**
 * Analyzes and validates a script along with all of its transitive
 * dependencies, producing a build graph that is ready to be executed.
 */
export class Analyzer {
  readonly #packageJsonReader = new CachingPackageJsonReader();
  readonly #placeholders = new Map<ScriptReferenceString, PlaceholderInfo>();
  readonly placeholderUpgradeWorkQueue: Array<
    Promise<Result<void, Failure[]>>
  > = [];

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
    root: ScriptReference
  ): Promise<Result<ScriptConfig, Failure[]>> {
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
    const errors = new Set<Failure>();
    while (this.placeholderUpgradeWorkQueue.length > 0) {
      const result = await this.placeholderUpgradeWorkQueue.shift();
      if (result?.ok === false) {
        for (const error of result.error) {
          errors.add(error);
        }
      }
    }
    if (errors.size > 0) {
      for (const error of errors) {
        const supercedes = (error as Partial<DependencyOnMissingPackageJson>)
          .supercedes;
        if (supercedes != null) {
          errors.delete(supercedes);
        }
      }
      return {ok: false, error: [...errors]};
    }

    // We can safely assume all placeholders have now been upgraded to full
    // configs.
    const rootConfig = rootPlaceholder.placeholder as ScriptConfig;
    const cycleResult = this.#checkForCyclesAndSortDependencies(
      rootConfig,
      new Set()
    );
    if (!cycleResult.ok) {
      return {ok: false, error: [cycleResult.error]};
    }
    return {ok: true, value: rootConfig};
  }

  async #readPackageJson(packageDir: string): Promise<Result<PackageJson>> {
    return this.#packageJsonReader.read(packageDir);
  }

  /**
   * Create or return a cached placeholder script configuration object for the
   * given script reference.
   */
  #getPlaceholder(reference: ScriptReference): PlaceholderInfo {
    const cacheKey = scriptReferenceToString(reference);
    let placeholderInfo = this.#placeholders.get(cacheKey);
    if (placeholderInfo === undefined) {
      const placeholder = {...reference};
      placeholderInfo = {
        placeholder: placeholder,
        resolutionPromise: this.#upgradePlaceholder(placeholder),
      };
      this.#placeholders.set(cacheKey, placeholderInfo);
      this.placeholderUpgradeWorkQueue.push(placeholderInfo?.resolutionPromise);
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
    placeholder: PlaceholderConfig
  ): Promise<Result<void, Failure[]>> {
    const packageJsonResult = await this.#readPackageJson(
      placeholder.packageDir
    );
    if (!packageJsonResult.ok) {
      return {ok: false, error: [packageJsonResult.error]};
    }
    const packageJson = packageJsonResult.value;
    if (packageJson.failures.length > 0) {
      return {ok: false, error: [...packageJson.failures]};
    }

    const syntaxInfo = packageJson.getScriptInfo(placeholder.name);
    if (syntaxInfo === undefined || syntaxInfo.scriptNode === undefined) {
      const range = packageJson.scriptsSection
        ? {
            offset: packageJson.scriptsSection.name.offset,
            length: packageJson.scriptsSection.name.length,
          }
        : {offset: 0, length: 0};
      return {
        ok: false,
        error: [
          {
            type: 'failure',
            reason: 'script-not-found',
            script: placeholder,
            diagnostic: {
              severity: 'error',
              message: `Script "${placeholder.name}" not found in the scripts section of this package.json.`,
              location: {file: packageJson.jsonFile, range},
            },
          },
        ],
      };
    }
    const scriptCommand = syntaxInfo.scriptNode;
    const wireitConfig = syntaxInfo.wireitConfigNode;

    if (wireitConfig !== undefined && scriptCommand.value !== 'wireit') {
      const configName = wireitConfig.name;
      return {
        ok: false,
        error: [
          {
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
          },
        ],
      };
    }

    if (wireitConfig === undefined && scriptCommand.value === 'wireit') {
      return {
        ok: false,
        error: [
          {
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
          },
        ],
      };
    }

    const dependencies: Array<PlaceholderConfig> = [];
    const dependenciesAst =
      wireitConfig && findNodeAtLocation(wireitConfig, ['dependencies']);
    if (dependenciesAst !== undefined) {
      const result = failUnlessArray(dependenciesAst, packageJson.jsonFile);
      if (!result.ok) {
        return {ok: false, error: [result.error]};
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
          return {ok: false, error: [stringResult.error]};
        }
        const unresolved = stringResult.value;
        const result = this.#resolveDependency(
          unresolved,
          placeholder,
          packageJson.jsonFile
        );
        if (!result.ok) {
          return {ok: false, error: [result.error]};
        }

        for (const resolved of result.value) {
          const uniqueKey = scriptReferenceToString(resolved);
          const duplicate = uniqueDependencies.get(uniqueKey);
          if (duplicate !== undefined) {
            return {
              ok: false,
              error: [
                {
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
                },
              ],
            };
          }
          uniqueDependencies.set(uniqueKey, unresolved);
          const placeHolderInfo = this.#getPlaceholder(resolved);
          dependencies.push(placeHolderInfo.placeholder);
          this.placeholderUpgradeWorkQueue.push(
            (async () => {
              const res = await placeHolderInfo.resolutionPromise;
              if (res.ok) {
                return {ok: true, value: undefined};
              }
              for (const failure of res.error) {
                if (failure.reason === 'script-not-found') {
                  const colonOffsetInString = packageJson.jsonFile.contents
                    .slice(unresolved.offset)
                    .indexOf(':');
                  let offset;
                  let length;
                  if (colonOffsetInString === -1) {
                    offset = unresolved.offset;
                    length = unresolved.length;
                  } else {
                    // Skip past the colon
                    offset = unresolved.offset + colonOffsetInString + 1;
                    length = unresolved.length - colonOffsetInString - 2;
                  }
                  return {
                    ok: false,
                    error: [
                      {
                        type: 'failure',
                        reason: 'dependency-on-missing-script',
                        script: placeholder,
                        diagnostic: {
                          severity: 'error',
                          message: `Cannot find script named ${JSON.stringify(
                            resolved.name
                          )} in package ${JSON.stringify(resolved.packageDir)}`,
                          location: {
                            file: packageJson.jsonFile,
                            range: {offset, length},
                          },
                        },
                      },
                    ],
                  };
                }
                if (failure.reason === 'missing-package-json') {
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
                  return {
                    ok: false,
                    error: [
                      {
                        type: 'failure',
                        reason: 'dependency-on-missing-package-json',
                        script: placeholder,
                        supercedes: failure,
                        diagnostic: {
                          severity: 'error',
                          message: `Package json file missing: ${JSON.stringify(
                            pathlib.join(resolved.packageDir, 'package.json')
                          )}`,
                          location: {file: packageJson.jsonFile, range},
                        },
                      },
                    ],
                  };
                }
              }
              return {ok: true, value: undefined};
            })()
          );
        }
      }
    }

    let command: JsonAstNode<string> | undefined;
    if (wireitConfig === undefined) {
      const result = failUnlessNonBlankString(
        scriptCommand,
        packageJson.jsonFile
      );
      if (!result.ok) {
        return {ok: false, error: [result.error]};
      }
      command = result.value;
    } else {
      const commandAst = findNodeAtLocation(wireitConfig, ['command']) as
        | undefined
        | JsonAstNode<string>;
      if (commandAst !== undefined) {
        const result = failUnlessNonBlankString(
          commandAst,
          packageJson.jsonFile
        );
        if (!result.ok) {
          return {ok: false, error: [result.error]};
        }
        command = result.value;
      }
    }

    let files: undefined | ArrayNode<string>;
    let output: undefined | ArrayNode<string>;
    let clean: undefined | JsonAstNode<true | false | 'if-file-deleted'>;
    if (wireitConfig !== undefined) {
      if (command === undefined && dependencies.length === 0) {
        return {
          ok: false,
          error: [
            {
              type: 'failure',
              reason: 'invalid-config-syntax',
              script: placeholder,
              diagnostic: {
                severity: 'error',
                message: `A wireit config must set at least one of "wireit" or "dependencies", otherwise there is nothing for wireit to do.`,
                location: {
                  file: packageJson.jsonFile,
                  range: {
                    length: wireitConfig.name.length,
                    offset: wireitConfig.name.offset,
                  },
                },
              },
            },
          ],
        };
      }

      const filesNode = findNodeAtLocation(wireitConfig, ['files']);
      if (filesNode !== undefined) {
        const values = [];
        const result = failUnlessArray(filesNode, packageJson.jsonFile);
        if (!result.ok) {
          return {ok: false, error: [result.error]};
        }
        const children = filesNode.children ?? [];
        for (let i = 0; i < children.length; i++) {
          const file = children[i];
          const result = failUnlessNonBlankString(file, packageJson.jsonFile);
          if (!result.ok) {
            return {ok: false, error: [result.error]};
          }
          values.push(result.value.value);
        }
        files = {node: filesNode, values};
      }

      const outputNode = findNodeAtLocation(wireitConfig, ['output']);
      if (outputNode !== undefined) {
        const values = [];
        const result = failUnlessArray(outputNode, packageJson.jsonFile);
        if (!result.ok) {
          return {ok: false, error: [result.error]};
        }
        const children = outputNode.children ?? [];
        for (let i = 0; i < children.length; i++) {
          const anOutput = children[i];
          const result = failUnlessNonBlankString(
            anOutput,
            packageJson.jsonFile
          );
          if (!result.ok) {
            return {ok: false, error: [result.error]};
          }
          values.push(result.value.value);
        }
        output = {node: outputNode, values};
      }
      clean = findNodeAtLocation(wireitConfig, ['clean']) as
        | undefined
        | JsonAstNode<true | false | 'if-file-deleted'>;
      if (
        clean !== undefined &&
        clean.value !== true &&
        clean.value !== false &&
        clean.value !== 'if-file-deleted'
      ) {
        return {
          ok: false,
          error: [
            {
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
            },
          ],
        };
      }

      const packageLocksNode = findNodeAtLocation(wireitConfig, [
        'packageLocks',
      ]);
      let packageLocks: undefined | {node: JsonAstNode; values: string[]};
      if (packageLocksNode !== undefined) {
        const result = failUnlessArray(packageLocksNode, packageJson.jsonFile);
        if (!result.ok) {
          return {ok: false, error: [result.error]};
        }
        packageLocks = {node: packageLocksNode, values: []};
        const children = packageLocksNode.children ?? [];
        for (let i = 0; i < children.length; i++) {
          const maybeFilename = children[i];
          const result = failUnlessNonBlankString(
            maybeFilename,
            packageJson.jsonFile
          );
          if (!result.ok) {
            return {ok: false, error: [result.error]};
          }
          const filename = result.value;
          if (filename.value !== pathlib.basename(filename.value)) {
            return {
              ok: false,
              error: [
                {
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
                },
              ],
            };
          }
          packageLocks.values.push(filename.value);
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

    // It's important to in-place update the placeholder object, instead of
    // creating a new object, because other configs may be referencing this
    // exact object in their dependencies.
    const remainingConfig: Omit<ScriptConfig, keyof ScriptReference> = {
      command,
      dependencies: dependencies as Array<ScriptConfig>,
      dependenciesAst,
      files,
      output,
      clean: clean?.value ?? true,
      scriptAstNode: scriptCommand,
      configAstNode: wireitConfig,
      declaringFile: packageJson.jsonFile,
    };
    Object.assign(placeholder, remainingConfig);
    return {ok: true, value: undefined};
  }

  #checkForCyclesAndSortDependencies(
    config: ScriptConfig,
    trail: Set<ScriptReferenceString>
  ): Result<void> {
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
        const placeholder = this.#placeholders.get(key);
        if (placeholder == null) {
          throw new Error(
            `Internal error: placeholder not found for ${key} during cycle detection`
          );
        }
        return placeholder.placeholder as ScriptConfig;
      });
      trailArray.push(config);
      const cycleEnd = trailArray.length - 1;
      for (let i = cycleStart; i < cycleEnd; i++) {
        const current = trailArray[i];
        const next = trailArray[i + 1];
        const nextIdx = current.dependencies.indexOf(next);
        const dependencyNode = current.dependenciesAst?.children?.[nextIdx];
        // Use the actual value in the array, because this could refer to
        // a script in another package.
        const nextName =
          dependencyNode?.value ?? next?.name ?? trailArray[cycleStart].name;
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
          dependencyNode ??
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
      return {
        ok: false,
        error: {
          type: 'failure',
          reason: 'cycle',
          script: config,
          diagnostic,
        },
      };
    }
    if (config.dependencies.length > 0) {
      // Sorting means that if the user re-orders the same set of dependencies,
      // the trail we take in this walk remains the same, so any cycle error
      // message we might throw will have the same trail, too. This also helps
      // make the caching keys that we'll be generating in the later execution
      // step insensitive to dependency order as well.
      config.dependencies.sort((a, b) => {
        if (a.packageDir !== b.packageDir) {
          return a.packageDir.localeCompare(b.packageDir);
        }
        return a.name.localeCompare(b.name);
      });
      trail.add(trailKey);
      for (const dependency of config.dependencies) {
        const result = this.#checkForCyclesAndSortDependencies(
          dependency,
          trail
        );
        if (!result.ok) {
          return result;
        }
      }
      trail.delete(trailKey);
    }
    return {ok: true, value: undefined};
  }

  /**
   * Resolve a dependency string specified in a "wireit.<script>.dependencies"
   * array, which may contain special syntax like relative paths or
   * "$WORKSPACES", into concrete packages and script names.
   *
   * Note this can return 0, 1, or >1 script references.
   */
  #resolveDependency(
    dependency: JsonAstNode<string>,
    context: ScriptReference,
    referencingFile: JsonFile
  ): Result<Array<ScriptReference>, Failure> {
    // TODO(aomarks) Implement $WORKSPACES syntax.
    if (dependency.value.startsWith('.')) {
      // TODO(aomarks) It is technically valid for an npm script to start with a
      // ".". We should support that edge case with backslash escaping.
      const result = this.#resolveCrossPackageDependency(
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
  #resolveCrossPackageDependency(
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
