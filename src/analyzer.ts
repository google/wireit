/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import {WireitError} from './error.js';
import {astKey, CachingPackageJsonReader} from './util/package-json-reader.js';
import {scriptReferenceToString, stringToScriptReference} from './script.js';
import {AggregateError} from './util/aggregate-error.js';

import type {CachingPackageJsonReaderError} from './util/package-json-reader.js';
import type {
  ScriptConfig,
  ScriptReference,
  ScriptReferenceString,
} from './script.js';
import {
  ArrayNode,
  AstNode,
  findNamedNodeAtLocation,
  findNodeAtLocation,
  NamedAstNode,
} from './util/ast.js';

/**
 * A {@link ScriptConfig} where all fields are optional apart from `packageDir`
 * and `name`, used temporarily while package.json files are still loading.
 */
export type PlaceholderConfig = ScriptReference & Partial<ScriptConfig>;

/**
 * Analyzes and validates a script along with all of its transitive
 * dependencies, producing a build graph that is ready to be executed.
 */
export class Analyzer {
  readonly #packageJsonReader = new CachingPackageJsonReader();
  readonly #placeholders = new Map<ScriptReferenceString, PlaceholderConfig>();
  readonly #placeholderUpgradePromises: Array<Promise<void>> = [];

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
    const rootPlaceholder = this.#getPlaceholder(root);

    // Note we can't use Promise.all here, because new promises can be added to
    // the promises array as long as any promise is pending.
    const errors = [];
    while (this.#placeholderUpgradePromises.length > 0) {
      try {
        await this.#placeholderUpgradePromises.shift();
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
    this.#checkForCyclesAndSortDependencies(rootConfig, new Set());
    return rootConfig;
  }

  /**
   * Create or return a cached placeholder script configuration object for the
   * given script reference.
   */
  #getPlaceholder(reference: ScriptReference): PlaceholderConfig {
    const cacheKey = scriptReferenceToString(reference);
    let placeholder = this.#placeholders.get(cacheKey);
    if (placeholder === undefined) {
      placeholder = {...reference};
      this.#placeholders.set(cacheKey, placeholder);
      this.#placeholderUpgradePromises.push(
        this.#upgradePlaceholder(placeholder)
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
  async #upgradePlaceholder(placeholder: PlaceholderConfig): Promise<void> {
    let packageJson;
    try {
      packageJson = await this.#packageJsonReader.read(
        placeholder.packageDir,
        placeholder
      );
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

    const packageJsonAst = packageJson[astKey];
    const scriptsSection = findNamedNodeAtLocation(
      packageJsonAst,
      ['scripts'],
      placeholder
    );
    if (scriptsSection === undefined) {
      throw new WireitError({
        type: 'failure',
        reason: 'no-scripts-in-package-json',
        script: placeholder,
      });
    }

    const wireitSection = findNamedNodeAtLocation(
      packageJsonAst,
      ['wireit'],
      placeholder
    );
    const scriptCommand = findNamedNodeAtLocation(
      scriptsSection,
      [placeholder.name],
      placeholder
    ) as undefined | NamedAstNode<string>;
    if (scriptCommand === undefined) {
      throw new WireitError({
        type: 'failure',
        reason: 'script-not-found',
        script: placeholder,
        astNode: wireitSection?.name ?? scriptsSection.name,
      });
    }
    assertNonBlankString(
      placeholder,
      scriptCommand.value,
      'command',
      scriptCommand
    );

    if (wireitSection !== undefined) {
      assertJsonObject(placeholder, wireitSection, 'wireit');
    }

    const wireitConfig =
      wireitSection &&
      (findNamedNodeAtLocation(
        wireitSection,
        [placeholder.name],
        placeholder
      ) as undefined | NamedAstNode);
    if (wireitConfig !== undefined) {
      assertJsonObject(
        placeholder,
        wireitConfig,
        `wireit[${placeholder.name}]`
      );
    }

    if (wireitConfig !== undefined && scriptCommand.value !== 'wireit') {
      throw new WireitError({
        type: 'failure',
        reason: 'script-not-wireit',
        script: placeholder,
        astNode: scriptCommand,
      });
    }

    if (wireitConfig === undefined && scriptCommand.value === 'wireit') {
      throw new WireitError({
        type: 'failure',
        reason: 'invalid-config-syntax',
        script: placeholder,
        message: `script has no wireit config`,
        astNode: scriptCommand,
      });
    }

    const dependencies: Array<PlaceholderConfig> = [];
    const dependenciesAst =
      wireitConfig &&
      (findNodeAtLocation(wireitConfig, ['dependencies']) as
        | undefined
        | AstNode);
    if (dependenciesAst !== undefined) {
      assertArray(placeholder, dependenciesAst, 'dependencies');
      // Error if the same dependency is declared multiple times. Duplicate
      // dependencies aren't necessarily a serious problem (since we already
      // prevent double-analysis here, and double-analysis in the Executor), but
      // they may indicate that the user has made a mistake (e.g. maybe they
      // meant a different dependency).
      const uniqueDependencies = new Map<string, AstNode>();
      const children = dependenciesAst.children ?? [];
      for (let i = 0; i < children.length; i++) {
        const unresolved = children[i] as AstNode<string>;
        assertNonBlankString(
          placeholder,
          unresolved.value,
          `dependencies[${i}]`,
          unresolved
        );
        for (const resolved of this.#resolveDependency(
          unresolved.value,
          placeholder,
          unresolved
        )) {
          const uniqueKey = scriptReferenceToString(resolved);
          const duplicate = uniqueDependencies.get(uniqueKey);
          if (duplicate !== undefined) {
            throw new WireitError({
              type: 'failure',
              reason: 'duplicate-dependency',
              script: placeholder,
              dependency: resolved,
              astNode: unresolved,
              duplicate,
            });
          }
          uniqueDependencies.set(uniqueKey, unresolved);
          dependencies.push(this.#getPlaceholder(resolved));
        }
      }
    }

    let command: AstNode<string> | undefined;
    if (wireitConfig === undefined) {
      assertNonBlankString(
        placeholder,
        scriptCommand.value,
        'command',
        scriptCommand
      );
      command = scriptCommand;
    } else {
      const commandAst = findNodeAtLocation(wireitConfig, ['command']) as undefined | AstNode<string>;
      if (commandAst !== undefined) {
        assertNonBlankString(
          placeholder,
          commandAst.value,
          'command',
          commandAst
        );
        command = commandAst;
      }
    }

    let files: undefined | ArrayNode<string>;
    let output: undefined | ArrayNode<string>;
    let clean: undefined | AstNode<true | false | 'if-file-deleted'>;
    if (wireitConfig !== undefined) {
      if (command === undefined && dependencies.length === 0) {
        throw new WireitError({
          type: 'failure',
          reason: 'invalid-config-syntax',
          script: placeholder,
          message: `script has no command and no dependencies`,
          astNode: wireitConfig.name,
        });
      }

      const filesNode = findNodeAtLocation(wireitConfig, ['files']) as
        | undefined
        | AstNode;
      if (filesNode !== undefined) {
        files = {node: filesNode, values: []};
        assertArray(placeholder, filesNode, 'files');
        const children = filesNode.children ?? [];
        for (let i = 0; i < children.length; i++) {
          const file = children[i] as AstNode<string>;
          assertNonBlankString(placeholder, file.value, `files[${i}]`, file);
          files.values.push(file.value);
        }
      }

      const outputNode = findNodeAtLocation(wireitConfig, ['output']) as
        | undefined
        | AstNode;
      if (outputNode !== undefined) {
        output = {node: outputNode, values: []};
        assertArray(placeholder, outputNode, 'output');
        const children = outputNode.children ?? [];
        for (let i = 0; i < children.length; i++) {
          const anOutput = children[i] as AstNode<string>;
          assertNonBlankString(
            placeholder,
            anOutput.value,
            `output[${i}]`,
            anOutput
          );
          output.values.push(anOutput.value);
        }
      }
      clean = findNodeAtLocation(wireitConfig, ['clean']) as
        | undefined
        | AstNode<true | false | 'if-file-deleted'>;
      if (
        clean !== undefined &&
        clean.value !== true &&
        clean.value !== false &&
        clean.value !== 'if-file-deleted'
      ) {
        throw new WireitError({
          script: placeholder,
          type: 'failure',
          reason: 'invalid-config-syntax',
          message: `clean must be true, false, or "if-file-deleted"`,
          astNode: clean,
        });
      }

      const packageLocksNode = findNodeAtLocation(wireitConfig, [
        'packageLocks',
      ]) as AstNode | undefined;
      let packageLocks: undefined | {node: AstNode, values: string[]};
      if (packageLocksNode !== undefined) {
        assertArray(placeholder, packageLocksNode, 'packageLocks');
        packageLocks = {node: packageLocksNode, values: []};
        const children = packageLocksNode.children ?? [];
        for (let i = 0; i < children.length; i++) {
          const filename = children[i] as AstNode<string>;
          assertNonBlankString(
            placeholder,
            filename.value,
            `packageLocks[${i}]`,
            filename
          );
          if (filename.value !== pathlib.basename(filename.value)) {
            throw new WireitError({
              type: 'failure',
              reason: 'invalid-config-syntax',
              script: placeholder,
              message: `packageLocks[${i}] must be a filename, not a path`,
              astNode: filename,
            });
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
      clean,
      scriptAstNode: scriptCommand,
      configAstNode: wireitConfig,
    };
    Object.assign(placeholder, remainingConfig);
  }

  #checkForCyclesAndSortDependencies(
    config: ScriptConfig,
    trail: Set<ScriptReferenceString>
  ) {
    const trailKey = scriptReferenceToString(config);
    if (trail.has(trailKey)) {
      // Found a cycle.
      const trailArray = [];
      let cycleStart = 0;
      // Trail is in graph traversal order because JavaScript Set iteration
      // order matches insertion order.
      let i = 0;
      for (const visited of trail) {
        trailArray.push(stringToScriptReference(visited));
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
        this.#checkForCyclesAndSortDependencies(dependency, trail);
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
  #resolveDependency(
    dependency: string,
    context: ScriptReference,
    reference: AstNode
  ): Array<ScriptReference> {
    // TODO(aomarks) Implement $WORKSPACES syntax.
    if (dependency.startsWith('.')) {
      // TODO(aomarks) It is technically valid for an npm script to start with a
      // ".". We should support that edge case with backslash escaping.
      return [
        this.#resolveCrossPackageDependency(dependency, context, reference),
      ];
    }
    return [{packageDir: context.packageDir, name: dependency}];
  }

  /**
   * Resolve a cross-package dependency (e.g. "../other-package:build").
   * Cross-package dependencies always start with a ".".
   */
  #resolveCrossPackageDependency(
    dependency: string,
    context: ScriptReference,
    reference: AstNode
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
        astNode: reference,
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
        astNode: reference,
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
        astNode: reference,
      });
    }
    return {packageDir: absolutePackageDir, name: scriptName};
  }
}

/**
 * Throw an error if the given value is not a string.
 */
const assertNonBlankString = (
  script: ScriptReference,
  value: unknown,
  name: string,
  astNode: AstNode
) => {
  if (typeof value !== 'string') {
    throw new WireitError({
      type: 'failure',
      reason: 'invalid-config-syntax',
      script,
      message: `${name} is not a string`,
      astNode,
    });
  }
  if (value.match(/^\s*$/)) {
    throw new WireitError({
      type: 'failure',
      reason: 'invalid-config-syntax',
      script,
      message: `${name} is empty or blank`,
      astNode,
    });
  }
};

/**
 * Throw an error if the given value is not an Array.
 */
const assertArray = (
  script: ScriptReference,
  astNode: AstNode,
  name: string
) => {
  if (astNode.type !== 'array') {
    throw new WireitError({
      type: 'failure',
      reason: 'invalid-config-syntax',
      script,
      message: `${name} is not an array`,
      astNode,
    });
  }
};

/**
 * Throw an error if it was an object literal ({...}), assuming it was parsed
 * from JSON.
 */
const assertJsonObject = (
  script: ScriptReference,
  astNode: AstNode,
  name: string
) => {
  if (astNode.type !== 'object') {
    throw new WireitError({
      type: 'failure',
      reason: 'invalid-config-syntax',
      script,
      astNode,
      message: `${name} is not an object`,
    });
  }
};
