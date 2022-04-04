/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fastGlob from 'fast-glob';
import * as pathlib from 'path';
import * as fs from 'fs/promises';
import {createHash} from 'crypto';
import {createReadStream, createWriteStream} from 'fs';
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
import type {WriteStream} from 'fs';

/**
 * Unique symbol to represent a script that isn't safe to be cached, because its
 * input files, or the input files of one of its transitive dependencies, are
 * undefined.
 */
const UNCACHEABLE = Symbol();

const IS_WINDOWS = process.platform === 'win32';

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
      promise = ScriptExecution.execute(script, this, this.#logger);
      this.#cache.set(cacheKey, promise);
    }
    return promise;
  }
}

/**
 * A single execution of a specific script.
 */
class ScriptExecution {
  static execute(
    script: ScriptConfig,
    executor: Executor,
    logger: Logger
  ): Promise<CacheKey | typeof UNCACHEABLE> {
    return new ScriptExecution(script, executor, logger).#execute();
  }

  readonly #script: ScriptConfig;
  readonly #logger: Logger;
  readonly #executor: Executor;

  private constructor(
    script: ScriptConfig,
    executor: Executor,
    logger: Logger
  ) {
    this.#script = script;
    this.#executor = executor;
    this.#logger = logger;
  }

  async #execute(): Promise<CacheKey | typeof UNCACHEABLE> {
    const dependencyCacheKeys = await this.#executeDependencies();
    // Note we must wait for dependencies to finish before generating the cache
    // key, because a dependency could create or modify an input file to this
    // script, which would affect the key.
    const cacheKey = await this.#getCacheKey(dependencyCacheKeys);
    let cacheKeyStr: CacheKeyString | typeof UNCACHEABLE;
    if (cacheKey !== UNCACHEABLE) {
      cacheKeyStr = JSON.stringify(cacheKey) as CacheKeyString;
      const previousCacheKeyStr = await this.#readStateFile();
      if (
        previousCacheKeyStr !== undefined &&
        cacheKeyStr === previousCacheKeyStr
      ) {
        await Promise.all([
          this.#replayStdoutIfPresent(),
          this.#replayStderrIfPresent(),
        ]);
        this.#logger.log({
          script: this.#script,
          type: 'success',
          reason: 'fresh',
        });
        return cacheKey;
      }
    } else {
      cacheKeyStr = UNCACHEABLE;
    }

    // It's important that we delete any previous state before running the
    // command, because if the command fails we won't update the state file,
    // even though the command might have produced some output.
    await this.#prepareDataDir();

    if (this.#script.clean) {
      await this.#cleanOutput();
    }

    // TODO(aomarks) Implement caching.
    await this.#executeCommandIfNeeded();

    if (cacheKeyStr !== UNCACHEABLE) {
      // TODO(aomarks) We don't technically need to wait for this to finish to
      // return, we only need to wait in the top-level call to execute. The same
      // will go for saving output to the cache.
      await this.#writeStateFile(cacheKeyStr);
    }
    return cacheKey;
  }

  async #executeDependencies(): Promise<
    Array<[ScriptReference, CacheKey | typeof UNCACHEABLE]>
  > {
    // Randomize the order we execute dependencies to make it less likely for a
    // user to inadvertently depend on any specific order, which could indicate
    // a missing edge in the dependency graph.
    shuffle(this.#script.dependencies);
    // Note we use Promise.allSettled instead of Promise.all so that we can
    // collect all errors, instead of just the first one.
    const dependencyResults = await Promise.allSettled(
      this.#script.dependencies.map((dependency) =>
        this.#executor.execute(dependency)
      )
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
        results.push([this.#script.dependencies[i], result.value]);
      }
    }
    if (errors.length > 0) {
      throw errors.length === 1 ? errors[0] : new AggregateError(errors);
    }
    return results;
  }

  async #executeCommandIfNeeded(): Promise<void> {
    // It's valid to not have a command defined, since thats a useful way to
    // alias a group of dependency scripts. In this case, we can return early.
    if (!this.#script.command) {
      this.#logger.log({
        script: this.#script,
        type: 'success',
        reason: 'no-command',
      });
      return;
    }

    this.#logger.log({
      script: this.#script,
      type: 'info',
      detail: 'running',
    });

    // TODO(aomarks) Fix PATH and npm_ environment variables to reflect the new
    // package when cross-package dependencies are supported.

    const child = spawn(this.#script.command, {
      cwd: this.#script.packageDir,
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

    // Only create the stdout/stderr replay files if we encounter anything on
    // this streams.
    let stdoutReplay: WriteStream | undefined;
    let stderrReplay: WriteStream | undefined;

    child.stdout.on('data', (data: string | Buffer) => {
      this.#logger.log({
        script: this.#script,
        type: 'output',
        stream: 'stdout',
        data,
      });
      if (stdoutReplay === undefined) {
        stdoutReplay = createWriteStream(this.#stdoutReplayPath);
      }
      stdoutReplay.write(data);
    });

    child.stderr.on('data', (data: string | Buffer) => {
      this.#logger.log({
        script: this.#script,
        type: 'output',
        stream: 'stderr',
        data,
      });
      if (stderrReplay === undefined) {
        stderrReplay = createWriteStream(this.#stderrReplayPath);
      }
      stderrReplay.write(data);
    });

    const completed = new Promise<void>((resolve, reject) => {
      child.on('error', (error) => {
        reject(
          new WireitError({
            script: this.#script,
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
              script: this.#script,
              type: 'failure',
              reason: 'signal',
              signal,
            })
          );
        } else if (status !== 0) {
          reject(
            new WireitError({
              script: this.#script,
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

    try {
      await completed;
    } finally {
      if (stdoutReplay !== undefined) {
        await closeWriteStream(stdoutReplay);
      }
      if (stderrReplay !== undefined) {
        await closeWriteStream(stderrReplay);
      }
    }

    this.#logger.log({
      script: this.#script,
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
    dependencyCacheKeys: Array<[ScriptReference, CacheKey | typeof UNCACHEABLE]>
  ): Promise<CacheKey | typeof UNCACHEABLE> {
    if (
      this.#script.files === undefined &&
      this.#script.command !== undefined
    ) {
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
    if (this.#script.files?.length) {
      const files = await fastGlob(this.#script.files, {
        cwd: this.#script.packageDir,
        dot: true,
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
          const absolutePath = pathlib.resolve(this.#script.packageDir, file);
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
      command: this.#script.command,
      clean: this.#script.clean,
      files: Object.fromEntries(
        fileHashes.sort(([aFile], [bFile]) => aFile.localeCompare(bFile))
      ),
      output: this.#script.output ?? [],
      dependencies: Object.fromEntries(
        filteredDependencyCacheKeys.sort(([aRef], [bRef]) =>
          aRef.localeCompare(bRef)
        )
      ),
    };
  }

  /**
   * Get the directory name where Wireit data can be saved for this script.
   */
  get #dataDir(): string {
    return pathlib.join(
      this.#script.packageDir,
      '.wireit',
      // Script names can contain any character, so they aren't safe to use
      // directly in a filepath, because certain characters aren't allowed on
      // certain filesystems (e.g. ":" is forbidden on Windows). Hex-encode
      // instead so that we only get safe ASCII characters.
      //
      // Reference:
      // https://docs.microsoft.com/en-us/windows/win32/fileio/naming-a-file#naming-conventions
      Buffer.from(this.#script.name).toString('hex')
    );
  }

  /**
   * Get the path where the current cache key is saved for this script.
   */
  get #statePath(): string {
    return pathlib.join(this.#dataDir, 'state');
  }

  /**
   * Get the path where the stdout replay is saved for this script.
   */
  get #stdoutReplayPath(): string {
    return pathlib.join(this.#dataDir, 'stdout');
  }

  /**
   * Get the path where the stderr replay is saved for this script.
   */
  get #stderrReplayPath(): string {
    return pathlib.join(this.#dataDir, 'stderr');
  }

  /**
   * Read this script's ".wireit/<hex-script-name>/state" file.
   */
  async #readStateFile(): Promise<CacheKeyString | undefined> {
    try {
      return (await fs.readFile(this.#statePath, 'utf8')) as CacheKeyString;
    } catch (error) {
      if ((error as {code?: string}).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Write this script's ".wireit/<hex-script-name>/state" file.
   */
  async #writeStateFile(cacheKeyStr: CacheKeyString): Promise<void> {
    await fs.mkdir(this.#dataDir, {recursive: true});
    await fs.writeFile(this.#statePath, cacheKeyStr, 'utf8');
  }

  /**
   * Delete all state for this script from the previous run, and ensure the data
   * directory is created.
   */
  async #prepareDataDir(): Promise<void> {
    await Promise.all([
      fs.rm(this.#statePath, {force: true}),
      fs.rm(this.#stdoutReplayPath, {force: true}),
      fs.rm(this.#stderrReplayPath, {force: true}),
      fs.mkdir(this.#dataDir, {recursive: true}),
    ]);
  }

  /**
   * Delete all files matched by this script's "output" glob patterns.
   */
  async #cleanOutput(): Promise<void> {
    if (this.#script.output === undefined) {
      return;
    }
    const absFiles = await this.#glob(this.#script.output, {
      onlyFiles: false,
      absolute: true,
    });
    if (absFiles.length === 0) {
      return;
    }
    const insidePackagePrefix = this.#script.packageDir + pathlib.sep;
    for (const absFile of absFiles) {
      // TODO(aomarks) It would be better to do this in the Analyzer by looking
      // at the output glob patterns, so that we catch errors earlier and can
      // provide a more useful message, but we need to be certain that we are
      // parsing glob patterns correctly (e.g. negations and other syntax make
      // it slightly tricky to detect).
      if (!absFile.startsWith(insidePackagePrefix)) {
        throw new WireitError({
          script: this.#script,
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
   * relative to this script's package directory.
   */
  async #glob(
    patterns: string[],
    {onlyFiles, absolute}: {onlyFiles: boolean; absolute: boolean}
  ): Promise<string[]> {
    const files = await fastGlob(patterns, {
      cwd: this.#script.packageDir,
      dot: true,
      onlyFiles,
      absolute,
    });
    if (IS_WINDOWS) {
      // fast-glob returns paths with forward-slash as the delimiter, even on
      // Windows. Normalize so that they are always valid filesystem paths.
      for (let i = 0; i < files.length; i++) {
        files[i] = pathlib.normalize(files[i]);
      }
    }
    return files;
  }

  /**
   * Write this script's stdout replay to stdout if it exists, otherwise do
   * nothing.
   */
  async #replayStdoutIfPresent(): Promise<void> {
    try {
      for await (const chunk of createReadStream(this.#stdoutReplayPath)) {
        this.#logger.log({
          script: this.#script,
          type: 'output',
          stream: 'stdout',
          data: chunk as Buffer,
        });
      }
    } catch (error) {
      if ((error as {code?: string}).code === 'ENOENT') {
        // There is no saved replay.
        return;
      }
    }
  }

  /**
   * Write this script's stderr replay to stderr if it exists, otherwise do
   * nothing.
   */
  async #replayStderrIfPresent(): Promise<void> {
    try {
      for await (const chunk of createReadStream(this.#stderrReplayPath)) {
        this.#logger.log({
          script: this.#script,
          type: 'output',
          stream: 'stderr',
          data: chunk as Buffer,
        });
      }
    } catch (error) {
      if ((error as {code?: string}).code === 'ENOENT') {
        // There is no saved replay.
        return;
      }
    }
  }
}

/**
 * Close the given write stream and resolve or reject the returned promise when
 * completed or failed.
 */
const closeWriteStream = (stream: WriteStream): Promise<void> => {
  return new Promise((resolve, reject) => {
    stream.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
};
