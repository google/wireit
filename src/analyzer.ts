/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import * as pathlib from 'path';
import {WireitError} from './error.js';
import {CachingPackageJsonReader} from './util/package-json-reader.js';
import {configReferenceToString, stringToConfigReference} from './script.js';

import type {CachingPackageJsonReaderError} from './util/package-json-reader.js';
import type {
  ScriptConfig,
  ScriptReference,
  ScriptReferenceString,
} from './script.js';

/**
 * A {@link ScriptConfig} where all fields are optional apart from `packageDir`
 * and `name`, used temporarily while package.json files are still loading.
 */
type PlaceholderConfig = ScriptReference & Partial<ScriptConfig>;

/**
 * Analyzes and validates a script along with all of its transitive
 * dependencies, producing a build graph that is ready to be executed.
 */
export class Analyzer {
  private readonly _packageJsonReader = new CachingPackageJsonReader();
  private readonly _placeholders = new Map<
    ScriptReferenceString,
    PlaceholderConfig
  >();
  private readonly _placeholderUpgradePromises: Array<Promise<void>> = [];

  /**
   * Load the Wireit configuration from the `package.json` corresponding to the
   * given script, repeat for all transitive dependencies, and return a build
   * graph that is ready to be executed.
   *
   * @throws {WireitError} If the given script or any of its transitive
   * dependencies don't exist, are configured in an invalid way, or if there is
   * a cycle in the dependency graph.
   */
  async analyze(root: ScriptReference): Promise<ScriptConfig> {
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
    const errors = [];
    while (this._placeholderUpgradePromises.length > 0) {
      try {
        await this._placeholderUpgradePromises.shift();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    } else if (errors.length > 0) {
      throw new AggregateError(errors);
    }

    // We can safely assume all placeholders have now been upgraded to full
    // configs.
    const rootConfig = rootPlaceholder as ScriptConfig;
    this._checkForCyclesAndSortDependencies(rootConfig, new Set());
    return rootConfig;
  }

  /**
   * Create or return a cached placeholder script configuration object for the
   * given script reference.
   */
  private _getPlaceholder(reference: ScriptReference): PlaceholderConfig {
    const cacheKey = configReferenceToString(reference);
    let placeholder = this._placeholders.get(cacheKey);
    if (placeholder === undefined) {
      placeholder = {...reference};
      this._placeholders.set(cacheKey, placeholder);
      this._placeholderUpgradePromises.push(
        this._upgradePlaceholder(placeholder)
      );
    }
    return placeholder;
  }

  /**
   * In-place upgrade the given placeholder script configuration object to a
   * full configuration, by reading its package.json file.
   *
   * Note this method does not block on the script's dependencies being
   * upgraded; dependencies are upgraded asynchronously.
   */
  private async _upgradePlaceholder(
    placeholder: PlaceholderConfig
  ): Promise<void> {
    let packageJson;
    try {
      packageJson = await this._packageJsonReader.read(placeholder.packageDir);
    } catch (error) {
      const reason = (error as CachingPackageJsonReaderError).reason;
      if (
        reason === 'missing-package-json' ||
        reason === 'invalid-package-json'
      ) {
        // Add extra context to make this exception a full WireitError.
        throw new WireitError({
          type: 'failure',
          reason,
          script: placeholder,
        });
      } else {
        throw error;
      }
    }

    if (
      packageJson.wireit !== undefined &&
      !isJsonObjectLiteral(packageJson.wireit)
    ) {
      throw new WireitError({
        type: 'failure',
        reason: 'invalid-config-syntax',
        script: placeholder,
        message: 'wireit is not an object',
      });
    }

    const scriptCommand = packageJson.scripts?.[placeholder.name];
    if (scriptCommand === undefined) {
      throw new WireitError({
        type: 'failure',
        reason: 'script-not-found',
        script: placeholder,
      });
    }

    const wireitConfig = packageJson.wireit?.[placeholder.name];
    if (wireitConfig !== undefined && !isJsonObjectLiteral(wireitConfig)) {
      throw new WireitError({
        type: 'failure',
        reason: 'invalid-config-syntax',
        script: placeholder,
        message: `wireit[${placeholder.name}] is not an object`,
      });
    }

    if (wireitConfig !== undefined && scriptCommand !== 'wireit') {
      throw new WireitError({
        type: 'failure',
        reason: 'script-not-wireit',
        script: placeholder,
      });
    }

    if (wireitConfig === undefined && scriptCommand === 'wireit') {
      throw new WireitError({
        type: 'failure',
        reason: 'invalid-config-syntax',
        script: placeholder,
        message: `script has no wireit config`,
      });
    }

    const dependencies: Array<PlaceholderConfig> = [];
    if (wireitConfig?.dependencies !== undefined) {
      if (!Array.isArray(wireitConfig.dependencies)) {
        throw new WireitError({
          type: 'failure',
          reason: 'invalid-config-syntax',
          script: placeholder,
          message: 'dependencies is not an array',
        });
      }
      // Error if the same dependency is declared multiple times. Duplicate
      // dependencies aren't necessarily a serious problem (since we already
      // prevent double-analysis here, and double-analysis in the Executor), but
      // they may indicate that the user has made a mistake (e.g. maybe they
      // meant a different dependency).
      const uniqueDependencies = new Set<string>();
      for (let i = 0; i < wireitConfig.dependencies.length; i++) {
        const unresolved = wireitConfig.dependencies[i];
        if (typeof unresolved !== 'string') {
          throw new WireitError({
            type: 'failure',
            reason: 'invalid-config-syntax',
            script: placeholder,
            message: `dependencies[${i}] is not a string`,
          });
        }
        for (const resolved of this._resolveDependency(
          unresolved,
          placeholder
        )) {
          const uniqueKey = configReferenceToString(resolved);
          if (uniqueDependencies.has(uniqueKey)) {
            throw new WireitError({
              type: 'failure',
              reason: 'duplicate-dependency',
              script: placeholder,
              dependency: resolved,
            });
          }
          uniqueDependencies.add(uniqueKey);
          dependencies.push(this._getPlaceholder(resolved));
        }
      }
    }

    let command: string | undefined;
    if (wireitConfig === undefined) {
      command = scriptCommand;
    } else {
      if (
        wireitConfig.command !== undefined &&
        typeof wireitConfig.command !== 'string'
      ) {
        throw new WireitError({
          type: 'failure',
          reason: 'invalid-config-syntax',
          script: placeholder,
          message: `command is not a string`,
        });
      }
      command = wireitConfig.command;
    }

    if (command === undefined && dependencies.length === 0) {
      throw new WireitError({
        type: 'failure',
        reason: 'invalid-config-syntax',
        script: placeholder,
        message: `script has no command and no dependencies`,
      });
    }

    // It's important to in-place update the placeholder object, instead of
    // creating a new object, because other configs may be referencing this
    // exact object in their dependencies.
    const remainingConfig: Omit<ScriptConfig, keyof ScriptReference> = {
      command,
      dependencies: dependencies as Array<ScriptConfig>,
    };
    Object.assign(placeholder, remainingConfig);
  }

  private _checkForCyclesAndSortDependencies(
    config: ScriptConfig,
    trail: Set<ScriptReferenceString>
  ) {
    const trailKey = configReferenceToString(config);
    if (trail.has(trailKey)) {
      // Found a cycle.
      const trailArray = [];
      let cycleStart = 0;
      // Trail is in graph traversal order because JavaScript Set iteration
      // order matches insertion order.
      let i = 0;
      for (const visited of trail) {
        trailArray.push(stringToConfigReference(visited));
        if (visited === trailKey) {
          cycleStart = i;
        }
        i++;
      }
      trailArray.push({packageDir: config.packageDir, name: config.name});
      throw new WireitError({
        type: 'failure',
        reason: 'cycle',
        script: config,
        length: trail.size - cycleStart,
        trail: trailArray,
      });
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
        this._checkForCyclesAndSortDependencies(dependency, trail);
      }
      trail.delete(trailKey);
    }
  }

  /**
   * Resolve a dependency string specified in a "wireit.<script>.dependencies"
   * array, which may contain special syntax like relative paths or
   * "$WORKSPACES", into concrete packages and script names.
   *
   * Note this can return 0, 1, or >1 script references.
   */
  private _resolveDependency(
    dependency: string,
    context: ScriptReference
  ): Array<ScriptReference> {
    // TODO(aomarks) Implement $WORKSPACES syntax.
    if (dependency.startsWith('.')) {
      // TODO(aomarks) It is technically valid for an npm script to start with a
      // ".". We should support that edge case with backslash escaping.
      return [this._resolveCrossPackageDependency(dependency, context)];
    }
    return [{packageDir: context.packageDir, name: dependency}];
  }

  /**
   * Resolve a cross-package dependency (e.g. "../other-package:build").
   * Cross-package dependencies always start with a ".".
   */
  private _resolveCrossPackageDependency(
    dependency: string,
    context: ScriptReference
  ) {
    // TODO(aomarks) On some file systems, it is valid to have a ":" in a file
    // path. We should support that edge case with backslash escaping.
    const firstColonIdx = dependency.indexOf(':');
    if (firstColonIdx === -1) {
      throw new WireitError({
        type: 'failure',
        reason: 'invalid-config-syntax',
        script: context,
        message:
          `Cross-package dependency must use syntax ` +
          `"<relative-path>:<script-name>", ` +
          `but there was no ":" character in "${dependency}".`,
      });
    }
    const scriptName = dependency.slice(firstColonIdx + 1);
    if (!scriptName) {
      throw new WireitError({
        type: 'failure',
        reason: 'invalid-config-syntax',
        script: context,
        message:
          `Cross-package dependency must use syntax ` +
          `"<relative-path>:<script-name>", ` +
          `but there was no script name in "${dependency}".`,
      });
    }
    const relativePackageDir = dependency.slice(0, firstColonIdx);
    const absolutePackageDir = pathlib.resolve(
      context.packageDir,
      relativePackageDir
    );
    if (absolutePackageDir === context.packageDir) {
      throw new WireitError({
        type: 'failure',
        reason: 'invalid-config-syntax',
        script: context,
        message:
          `Cross-package dependency "${dependency}" ` +
          `resolved to the same package.`,
      });
    }
    return {packageDir: absolutePackageDir, name: scriptName};
  }
}

/**
 * Assuming the given value was parsed from JSON, return whether it was an
 * object literal ({...}).
 */
const isJsonObjectLiteral = (value: unknown) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
