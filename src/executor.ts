/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fastGlob from 'fast-glob';
import * as pathlib from 'path';
import * as fs from 'fs/promises';
import {createHash} from 'crypto';
import {createReadStream} from 'fs';
import {spawn} from 'child_process';
import {WireitError} from './error.js';
import {scriptReferenceToString} from './script.js';
import {shuffle} from './util/shuffle.js';

import type {
  ScriptConfig,
  ScriptReference,
  ScriptReferenceString,
  CacheKey,
  CacheKeyString,
  Sha256HexDigest,
} from './script.js';
import type {Logger} from './logging/logger.js';

/**
 * Unique symbol to represent a script that isn't safe to be cached, because its
 * input files, or the input files of one of its transitive dependencies, are
 * undefined.
 */
const UNCACHEABLE = Symbol();

/**
 * Executes a script that has been analyzed and validated by the Analyzer.
 */
export class Executor {
  readonly #cache = new Map<string, Promise<CacheKey | typeof UNCACHEABLE>>();
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  async execute(script: ScriptConfig): Promise<CacheKey | typeof UNCACHEABLE> {
    const cacheKey = scriptReferenceToString(script);
    let promise = this.#cache.get(cacheKey);
    if (promise === undefined) {
      promise = this.#execute(script);
      this.#cache.set(cacheKey, promise);
    }
    return promise;
  }

  async #execute(script: ScriptConfig): Promise<CacheKey | typeof UNCACHEABLE> {
    const dependencyCacheKeys = await this.#executeDependencies(script);
    // Note we must wait for dependencies to finish before generating the cache
    // key, because a dependency could create or modify an input file to this
    // script, which would affect the key.
    const cacheKey = await this.#getCacheKey(script, dependencyCacheKeys);
    let cacheKeyStr: CacheKeyString | typeof UNCACHEABLE;
    if (cacheKey !== UNCACHEABLE) {
      cacheKeyStr = JSON.stringify(cacheKey) as CacheKeyString;
      const previousCacheKeyStr = await this.#readStateFile(script);
      if (
        previousCacheKeyStr !== undefined &&
        cacheKeyStr === previousCacheKeyStr
      ) {
        this.#logger.log({
          script,
          type: 'success',
          reason: 'fresh',
        });
        return cacheKey;
      }
    } else {
      cacheKeyStr = UNCACHEABLE;
    }

    // It's important that we delete any previous state file before running the
    // command, because if the command fails we won't update the state file,
    // even though the command might have produced some output.
    await this.#deleteStateFile(script);

    if (script.clean) {
      await this.#cleanOutput(script);
    }

    // TODO(aomarks) Implement caching.
    await this.#executeCommandIfNeeded(script);

    if (cacheKeyStr !== UNCACHEABLE) {
      // TODO(aomarks) We don't technically need to wait for this to finish to
      // return, we only need to wait in the top-level call to execute. The same
      // will go for saving output to the cache.
      await this.#writeStateFile(script, cacheKeyStr);
    }
    return cacheKey;
  }

  async #executeDependencies(
    script: ScriptConfig
  ): Promise<Array<[ScriptReference, CacheKey | typeof UNCACHEABLE]>> {
    // Randomize the order we execute dependencies to make it less likely for a
    // user to inadvertently depend on any specific order, which could indicate
    // a missing edge in the dependency graph.
    shuffle(script.dependencies);
    // Note we use Promise.allSettled instead of Promise.all so that we can
    // collect all errors, instead of just the first one.
    const dependencyResults = await Promise.allSettled(
      script.dependencies.map((dependency) => this.execute(dependency))
    );
    const errors: unknown[] = [];
    const results: Array<[ScriptReference, CacheKey | typeof UNCACHEABLE]> = [];
    for (let i = 0; i < dependencyResults.length; i++) {
      const result = dependencyResults[i];
      if (result.status === 'rejected') {
        const error: unknown = result.reason;
        if (error instanceof AggregateError) {
          // Flatten nested AggregateErrors.
          errors.push(...(error.errors as unknown[]));
        } else {
          errors.push(error);
        }
      } else {
        results.push([script.dependencies[i], result.value]);
      }
    }
    if (errors.length > 0) {
      throw errors.length === 1 ? errors[0] : new AggregateError(errors);
    }
    return results;
  }

  async #executeCommandIfNeeded(script: ScriptConfig): Promise<void> {
    // It's valid to not have a command defined, since thats a useful way to
    // alias a group of dependency scripts. In this case, we can return early.
    if (!script.command) {
      this.#logger.log({
        script,
        type: 'success',
        reason: 'no-command',
      });
      return;
    }

    this.#logger.log({
      script,
      type: 'info',
      detail: 'running',
    });

    // TODO(aomarks) Fix PATH and npm_ environment variables to reflect the new
    // package when cross-package dependencies are supported.

    const child = spawn(script.command, {
      cwd: script.packageDir,
      // Conveniently, "shell:true" has the same shell-selection behavior as
      // "npm run", where on macOS and Linux it is "sh", and on Windows it is
      // %COMSPEC% || "cmd.exe".
      //
      // References:
      //   https://nodejs.org/api/child_process.html#child_processspawncommand-args-options
      //   https://nodejs.org/api/child_process.html#default-windows-shell
      //   https://github.com/npm/run-script/blob/a5b03bdfc3a499bf7587d7414d5ea712888bfe93/lib/make-spawn-args.js#L11
      shell: true,
    });

    child.stdout.on('data', (data: string | Buffer) => {
      this.#logger.log({
        script,
        type: 'output',
        stream: 'stdout',
        data,
      });
    });

    child.stderr.on('data', (data: string | Buffer) => {
      this.#logger.log({
        script,
        type: 'output',
        stream: 'stderr',
        data,
      });
    });

    const completed = new Promise<void>((resolve, reject) => {
      child.on('error', (error) => {
        reject(
          new WireitError({
            script,
            type: 'failure',
            reason: 'spawn-error',
            message: error.message,
          })
        );
      });

      child.on('close', (status, signal) => {
        if (signal !== null) {
          reject(
            new WireitError({
              script,
              type: 'failure',
              reason: 'signal',
              signal,
            })
          );
        } else if (status !== 0) {
          reject(
            new WireitError({
              script,
              type: 'failure',
              reason: 'exit-non-zero',
              // status should only ever be null if signal was not null, but
              // this isn't reflected in the TypeScript types. Just in case, and
              // to make TypeScript happy, fall back to -1 (which is a
              // conventional exit status used for "exited with signal").
              status: status ?? -1,
            })
          );
        } else {
          resolve();
        }
      });
    });

    await completed;

    this.#logger.log({
      script,
      type: 'success',
      reason: 'exit-zero',
    });
  }

  /**
   * Generate the cache key for this script based on its current input files,
   * and the cache keys of its dependencies.
   *
   * Returns the sentinel value {@link UNCACHEABLE} if this script, or any of
   * this script's transitive dependencies, have undefined input files.
   */
  async #getCacheKey(
    script: ScriptConfig,
    dependencyCacheKeys: Array<[ScriptReference, CacheKey | typeof UNCACHEABLE]>
  ): Promise<CacheKey | typeof UNCACHEABLE> {
    if (script.files === undefined && script.command !== undefined) {
      // If files are undefined, then it's never safe for us to be cached,
      // because we don't know what the inputs are, so we can't know if the
      // output of this script could change.
      //
      // However, if the command is also undefined, then it actually _is_ safe
      // to be cached, because the script isn't itself going to do anything
      // anyway. In that case, the cache keys will be purely the cache keys of
      // the dependencies.
      return UNCACHEABLE;
    }

    const filteredDependencyCacheKeys: Array<
      [ScriptReferenceString, CacheKey]
    > = [];
    for (const [dep, depCacheKey] of dependencyCacheKeys) {
      if (depCacheKey === UNCACHEABLE) {
        // If one of our dependencies is uncacheable, then we're uncacheable
        // too, because that dependency could have an effect on our output.
        return UNCACHEABLE;
      }
      filteredDependencyCacheKeys.push([
        scriptReferenceToString(dep),
        depCacheKey,
      ]);
    }

    let fileHashes: Array<[string, Sha256HexDigest]>;
    if (script.files?.length) {
      const files = await this.#glob(script, script.files, {
        // TODO(aomarks) It is possible for a script to produce different output
        // when an empty directory is added. Consider whether we should actually
        // include directories here. Directories will need to have some special
        // handling in the cache key, since they have no content to hash.
        onlyFiles: true,
        absolute: false,
      });
      // TODO(aomarks) Instead of reading and hashing every input file on every
      // build, use inode/mtime/ctime/size metadata (which is much faster to
      // read) as a heuristic to detect files that have likely changed, and
      // otherwise re-use cached hashes that we store in e.g.
      // ".wireit/<script>/hashes".
      fileHashes = await Promise.all(
        files.map(async (file): Promise<[string, Sha256HexDigest]> => {
          const absolutePath = pathlib.resolve(script.packageDir, file);
          const hash = createHash('sha256');
          for await (const chunk of createReadStream(absolutePath)) {
            hash.update(chunk as Buffer);
          }
          return [file, hash.digest('hex') as Sha256HexDigest];
        })
      );
    } else {
      fileHashes = [];
    }

    return {
      command: script.command,
      clean: script.clean,
      files: Object.fromEntries(
        fileHashes.sort(([aFile], [bFile]) => aFile.localeCompare(bFile))
      ),
      output: script.output ?? [],
      dependencies: Object.fromEntries(
        filteredDependencyCacheKeys.sort(([aRef], [bRef]) =>
          aRef.localeCompare(bRef)
        )
      ),
    };
  }

  /**
   * Get the directory name where Wireit data can be saved for a script.
   */
  #getScriptDataDir(script: ScriptReference): string {
    return pathlib.join(
      script.packageDir,
      '.wireit',
      // Script names can contain any character, so they aren't safe to use
      // directly in a filepath, because certain characters aren't allowed on
      // certain filesystems (e.g. ":" is forbidden on Windows). Hex-encode
      // instead so that we only get safe ASCII characters.
      //
      // Reference:
      // https://docs.microsoft.com/en-us/windows/win32/fileio/naming-a-file#naming-conventions
      Buffer.from(script.name).toString('hex')
    );
  }

  /**
   * Read a script's ".wireit/<hex-script-name>/state" file.
   */
  async #readStateFile(
    script: ScriptReference
  ): Promise<CacheKeyString | undefined> {
    const stateFilepath = pathlib.join(this.#getScriptDataDir(script), 'state');
    try {
      return (await fs.readFile(stateFilepath, 'utf8')) as CacheKeyString;
    } catch (error) {
      if ((error as {code?: string}).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Write a script's ".wireit/<hex-script-name>/state" file.
   */
  async #writeStateFile(
    script: ScriptReference,
    cacheKeyStr: CacheKeyString
  ): Promise<void> {
    const dataDir = this.#getScriptDataDir(script);
    await fs.mkdir(dataDir, {recursive: true});
    const stateFilepath = pathlib.join(dataDir, 'state');
    await fs.writeFile(stateFilepath, cacheKeyStr, 'utf8');
  }

  /**
   * Delete a script's ".wireit/<hex-script-name>/state" file.
   */
  async #deleteStateFile(script: ScriptReference): Promise<void> {
    const stateFilepath = pathlib.join(this.#getScriptDataDir(script), 'state');
    try {
      await fs.unlink(stateFilepath);
    } catch (error) {
      if ((error as {code?: string}).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Delete all files matched by the given script's "output" glob patterns.
   */
  async #cleanOutput(script: ScriptConfig): Promise<void> {
    if (script.output === undefined) {
      return;
    }
    const absFiles = await this.#glob(script, script.output, {
      onlyFiles: false,
      absolute: true,
    });
    if (absFiles.length === 0) {
      return;
    }
    const insidePackagePrefix = script.packageDir + pathlib.sep;
    for (const absFile of absFiles) {
      // TODO(aomarks) It would be better to do this in the Analyzer by looking
      // at the output glob patterns, so that we catch errors earlier and can
      // provide a more useful message, but we need to be certain that we are
      // parsing glob patterns correctly (e.g. negations and other syntax make
      // it slightly tricky to detect).
      if (!absFile.startsWith(insidePackagePrefix)) {
        throw new WireitError({
          script,
          type: 'failure',
          reason: 'invalid-config-syntax',
          message: `refusing to delete output file outside of package: ${absFile}`,
        });
      }
    }
    await Promise.all(
      absFiles.map(async (absFile) => {
        try {
          await fs.rm(absFile, {recursive: true});
        } catch (error) {
          if ((error as {code?: string}).code !== 'ENOENT') {
            throw error;
          }
        }
      })
    );
  }

  /**
   * Match the given glob patterns against the filesystem, interpreting paths
   * relative to the given script's package directory.
   */
  async #glob(
    script: ScriptConfig,
    patterns: string[],
    {onlyFiles, absolute}: {onlyFiles: boolean; absolute: boolean}
  ): Promise<string[]> {
    return fastGlob(patterns, {
      cwd: script.packageDir,
      dot: true,
      onlyFiles,
      absolute,
    });
  }
}
