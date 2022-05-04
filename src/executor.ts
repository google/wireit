/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import * as fs from 'fs/promises';
import {createHash} from 'crypto';
import {createReadStream, createWriteStream} from 'fs';
import {spawn} from 'child_process';
import {WireitError} from './error.js';
import {scriptReferenceToString} from './script.js';
import {shuffle} from './util/shuffle.js';
import {WorkerPool} from './util/worker-pool.js';
import {getScriptDataDir} from './util/script-data-dir.js';
import {unreachable} from './util/unreachable.js';
import {glob, GlobOutsideCwdError} from './util/glob.js';
import {deleteEntries} from './util/delete.js';
import {AggregateError} from './util/aggregate-error.js';
import {
  augmentProcessEnvSafelyIfOnWindows,
  posixifyPathIfOnWindows,
} from './util/windows.js';

import type {
  ScriptConfig,
  ScriptReference,
  ScriptReferenceString,
  ScriptState,
  ScriptStateString,
  Sha256HexDigest,
} from './script.js';
import type {Logger} from './logging/logger.js';
import type {WriteStream} from 'fs';
import type {Cache} from './caching/cache.js';

/**
 * The PATH environment variable of this process, minus all of the leading
 * "node_modules/.bin" entries that the incoming "npm run" command already set.
 *
 * We want full control over which "node_modules/.bin" paths are in the PATH of
 * the processes we spawn, so that cross-package dependencies act as though we
 * are running "npm run" with each package as the cwd.
 *
 * We only need to do this once per Wireit process, because process.env never
 * changes.
 */
const PATH_ENV_SUFFIX = (() => {
  const path = process.env.PATH ?? '';
  // Note the PATH delimiter is platform-dependent.
  const entries = path.split(pathlib.delimiter);
  const nodeModulesBinSuffix = pathlib.join('node_modules', '.bin');
  const endOfNodeModuleBins = entries.findIndex(
    (entry) => !entry.endsWith(nodeModulesBinSuffix)
  );
  return entries.slice(endOfNodeModuleBins).join(pathlib.delimiter);
})();

/**
 * Executes a script that has been analyzed and validated by the Analyzer.
 */
export class Executor {
  readonly #executions = new Map<string, Promise<ScriptState>>();
  readonly #logger: Logger;
  readonly #workerPool: WorkerPool;
  readonly #cache?: Cache;

  constructor(
    logger: Logger,
    workerPool: WorkerPool,
    cache: Cache | undefined
  ) {
    this.#logger = logger;
    this.#workerPool = workerPool;
    this.#cache = cache;
  }

  async execute(script: ScriptConfig): Promise<ScriptState> {
    const executionKey = scriptReferenceToString(script);
    let promise = this.#executions.get(executionKey);
    if (promise === undefined) {
      promise = ScriptExecution.execute(
        script,
        this,
        this.#workerPool,
        this.#cache,
        this.#logger
      );
      this.#executions.set(executionKey, promise);
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
    workerPool: WorkerPool,
    cache: Cache | undefined,
    logger: Logger
  ): Promise<ScriptState> {
    return new ScriptExecution(
      script,
      executor,
      workerPool,
      cache,
      logger
    ).#execute();
  }

  readonly #script: ScriptConfig;
  readonly #executor: Executor;
  readonly #cache?: Cache;
  readonly #workerPool: WorkerPool;
  readonly #logger: Logger;

  private constructor(
    script: ScriptConfig,
    executor: Executor,
    workerPool: WorkerPool,
    cache: Cache | undefined,
    logger: Logger
  ) {
    this.#script = script;
    this.#executor = executor;
    this.#workerPool = workerPool;
    this.#cache = cache;
    this.#logger = logger;
  }

  async #execute(): Promise<ScriptState> {
    const dependencyStates = await this.#executeDependencies();
    // Note we must wait for dependencies to finish before generating the cache
    // key, because a dependency could create or modify an input file to this
    // script, which would affect the key.
    const state = await this.#computeState(dependencyStates);
    const stateStr = JSON.stringify(state) as ScriptStateString;
    const prevStateStr = await this.#readPreviousState();
    if (
      state.cacheable &&
      prevStateStr !== undefined &&
      prevStateStr === stateStr
    ) {
      // TODO(aomarks) Does not preserve original order of stdout vs stderr
      // chunks. See https://github.com/google/wireit/issues/74.
      await Promise.all([
        this.#replayStdoutIfPresent(),
        this.#replayStderrIfPresent(),
      ]);
      this.#logger.log({
        script: this.#script,
        type: 'success',
        reason: 'fresh',
      });
      return state;
    }

    // It's important that we delete any previous state before running the
    // command or restoring from cache, because if either fails mid-flight, we
    // don't want to think that the previous state is still valid.
    await this.#prepareDataDir();

    const cacheHit = state.cacheable
      ? await this.#cache?.get(this.#script, stateStr)
      : undefined;

    const shouldClean = (() => {
      if (cacheHit !== undefined) {
        // If we are restoring from cache, we should always delete existing
        // output. The purpose of "clean:false" and "clean:if-file-deleted" is to
        // allow tools with incremental build (like tsc --build) to work.
        //
        // However, this only applies when the tool is able to observe each
        // incremental change to the input files. When we restore from cache, we
        // are directly replacing the output files, and not invoking the tool at
        // all, so there is no way for the tool to do any cleanup.
        return true;
      }
      const cleanValue = this.#script.clean;
      switch (cleanValue) {
        case true: {
          return true;
        }
        case false: {
          return false;
        }
        case 'if-file-deleted': {
          if (prevStateStr === undefined) {
            // If we don't know the previous state, then we can't know whether
            // any input files were removed. It's safer to err on the side of
            // cleaning.
            return true;
          }
          return this.#anyInputFilesDeletedSinceLastRun(
            state,
            JSON.parse(prevStateStr) as ScriptState
          );
        }
        default: {
          throw new Error(
            `Unhandled clean setting: ${unreachable(cleanValue) as string}`
          );
        }
      }
    })();
    if (shouldClean) {
      await this.#cleanOutput();
    }

    if (cacheHit !== undefined) {
      await cacheHit.apply();
      // We include stdout and stderr replay files when we save to the cache, so
      // if there were any, they will now be in place.
      // TODO(aomarks) Does not preserve original order of stdout vs stderr
      // chunks. See https://github.com/google/wireit/issues/74.
      await Promise.all([
        this.#replayStdoutIfPresent(),
        this.#replayStderrIfPresent(),
      ]);
      this.#logger.log({
        script: this.#script,
        type: 'success',
        reason: 'cached',
      });
    } else {
      await this.#executeCommandIfNeeded();
    }

    // TODO(aomarks) We don't technically need to wait for these to finish to
    // return, we only need to wait in the top-level call to execute. The same
    // will go for saving output to the cache.
    await this.#writeStateFile(stateStr);
    if (cacheHit === undefined && state.cacheable) {
      await this.#saveToCacheIfPossible(stateStr);
    }

    return state;
  }

  /**
   * Compares the current set of input file names to the previous set of input
   * file names, and returns whether any files have been removed.
   */
  #anyInputFilesDeletedSinceLastRun(
    curState: ScriptState,
    prevState: ScriptState
  ): boolean {
    const curFiles = Object.keys(curState.files);
    const prevFiles = Object.keys(prevState.files);
    if (curFiles.length < prevFiles.length) {
      return true;
    }
    const newFilesSet = new Set(curFiles);
    for (const oldFile of prevFiles) {
      if (!newFilesSet.has(oldFile)) {
        return true;
      }
    }
    return false;
  }

  async #executeDependencies(): Promise<Array<[ScriptReference, ScriptState]>> {
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
    const results: Array<[ScriptReference, ScriptState]> = [];
    for (let i = 0; i < dependencyResults.length; i++) {
      const result = dependencyResults[i];
      if (result.status === 'rejected') {
        const error: unknown = result.reason;
        if (error instanceof AggregateError) {
          // Flatten nested AggregateErrors.
          errors.push(...error.errors);
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

    const command = this.#script.command;
    await this.#workerPool.run(async () => {
      // TODO(aomarks) Update npm_ environment variables to reflect the new
      // package.
      const child = spawn(command.value, {
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
        env: augmentProcessEnvSafelyIfOnWindows({
          PATH: this.#pathEnvironmentVariable,
        }),
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
    });

    this.#logger.log({
      script: this.#script,
      type: 'success',
      reason: 'exit-zero',
    });
  }

  /**
   * Generates the PATH environment variable that should be set when this
   * script's command is spawned.
   */
  get #pathEnvironmentVariable(): string {
    // Given package "/foo/bar", walk up the path hierarchy to generate
    // "/foo/bar/node_modules/.bin:/foo/node_modules/.bin:/node_modules/.bin".
    const entries = [];
    let cur = this.#script.packageDir;
    while (true) {
      entries.push(pathlib.join(cur, 'node_modules', '.bin'));
      const parent = pathlib.dirname(cur);
      if (parent === cur) {
        break;
      }
      cur = parent;
    }
    // Add the inherited PATH variable, minus any "node_modules/.bin" entries
    // that were set by the "npm run" command that spawned Wireit.
    entries.push(PATH_ENV_SUFFIX);
    // Note the PATH delimiter is platform-dependent.
    return entries.join(pathlib.delimiter);
  }

  /**
   * Save the current output files to the configured cache if possible.
   */
  async #saveToCacheIfPossible(stateStr: ScriptStateString): Promise<void> {
    if (this.#cache === undefined || this.#script.output === undefined) {
      return;
    }
    let paths;
    try {
      paths = await glob(
        [
          ...this.#script.output.values,
          // Also include the "stdout" and "stderr" replay files at their
          // standard location within the ".wireit" directory for this script so
          // that we can replay them after restoring.
          //
          // We're passing this to #glob because it's an easy way to only
          // include them only if they exist. We don't want to include files
          // that don't exist becuase then we'll make empty directories and will
          // get an error from fs.cp.
          //
          // Convert to relative paths because we want to pass relative paths to
          // Cache.set, but fast-glob doesn't automatically relativize to the
          // cwd when passing an absolute path.
          //
          // Convert Windows-style paths to POSIX-style paths if we are on
          // Windows, because fast-glob only understands POSIX-style paths.
          posixifyPathIfOnWindows(
            pathlib.relative(this.#script.packageDir, this.#stdoutReplayPath)
          ),
          posixifyPathIfOnWindows(
            pathlib.relative(this.#script.packageDir, this.#stderrReplayPath)
          ),
        ],
        {
          cwd: this.#script.packageDir,
          absolute: false,
          followSymlinks: false,
          includeDirectories: true,
          expandDirectories: true,
          throwIfOutsideCwd: true,
        }
      );
    } catch (error) {
      if (error instanceof GlobOutsideCwdError) {
        // TODO(aomarks) It would be better to do this in the Analyzer by
        // looking at the output glob patterns. See
        // https://github.com/google/wireit/issues/64.
        throw new WireitError({
          script: this.#script,
          type: 'failure',
          reason: 'invalid-config-syntax',
          diagnostic: {
            severity: 'error',
            message: `Output files must be within the package: ${error.message}`,
            location: {
              file: this.#script.declaringFile,
              range: {
                offset: this.#script.output.node.offset,
                length: this.#script.output.node.length,
              },
            },
          },
        });
      }
      throw error;
    }
    await this.#cache.set(this.#script, stateStr, paths);
  }

  /**
   * Generate the state object for this script based on its current input files,
   * and the state of its dependencies.
   */
  async #computeState(
    dependencyStates: Array<[ScriptReference, ScriptState]>
  ): Promise<ScriptState> {
    let allDependenciesAreCacheable = true;
    const filteredDependencyStates: Array<
      [ScriptReferenceString, ScriptState]
    > = [];
    for (const [dep, depState] of dependencyStates) {
      if (!depState.cacheable) {
        allDependenciesAreCacheable = false;
      }
      filteredDependencyStates.push([scriptReferenceToString(dep), depState]);
    }

    let fileHashes: Array<[string, Sha256HexDigest]>;
    if (this.#script.files?.values.length) {
      const files = await glob(this.#script.files.values, {
        cwd: this.#script.packageDir,
        absolute: false,
        followSymlinks: true,
        // TODO(aomarks) This means that empty directories are not reflected in
        // the state, however an empty directory could modify the behavior of a
        // script. We should probably include empty directories; we'll just need
        // special handling when we compute the state key, because there is no
        // hash we can compute.
        includeDirectories: false,
        // We must expand directories here, because we need the complete
        // explicit list of files to hash.
        expandDirectories: true,
        throwIfOutsideCwd: false,
      });
      // TODO(aomarks) Instead of reading and hashing every input file on every
      // build, use inode/mtime/ctime/size metadata (which is much faster to
      // read) as a heuristic to detect files that have likely changed, and
      // otherwise re-use cached hashes that we store in e.g.
      // ".wireit/<script>/hashes".
      fileHashes = await Promise.all(
        files.map(async (file): Promise<[string, Sha256HexDigest]> => {
          const absolutePath = pathlib.resolve(
            this.#script.packageDir,
            file.path
          );
          const hash = createHash('sha256');
          for await (const chunk of createReadStream(absolutePath)) {
            hash.update(chunk as Buffer);
          }
          return [file.path, hash.digest('hex') as Sha256HexDigest];
        })
      );
    } else {
      fileHashes = [];
    }

    const cacheable =
      // If command is undefined, then it's always safe to be cached, because
      // the script isn't going to do anything anyway. In these cases, the state
      // is essentially just the state of the dependencies.
      this.#script.command === undefined ||
      // Otherwise, If files are undefined, then it's not safe to be cached,
      // because we don't know what the inputs are, so we can't know if the
      // output of this script could change.
      (this.#script.files !== undefined &&
        // Similarly, if any of our dependencies are uncacheable, then we're
        // uncacheable too, because that dependency could also have an effect on
        // our output.
        allDependenciesAreCacheable);

    return {
      cacheable,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      command: this.#script.command?.value,
      clean: this.#script.clean,
      files: Object.fromEntries(
        fileHashes.sort(([aFile], [bFile]) => aFile.localeCompare(bFile))
      ),
      output: this.#script.output?.values ?? [],
      dependencies: Object.fromEntries(
        filteredDependencyStates.sort(([aRef], [bRef]) =>
          aRef.localeCompare(bRef)
        )
      ),
    };
  }

  /**
   * Get the directory name where Wireit data can be saved for this script.
   */
  get #dataDir(): string {
    return getScriptDataDir(this.#script);
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
  async #readPreviousState(): Promise<ScriptStateString | undefined> {
    try {
      return (await fs.readFile(this.#statePath, 'utf8')) as ScriptStateString;
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
  async #writeStateFile(stateStr: ScriptStateString): Promise<void> {
    await fs.mkdir(this.#dataDir, {recursive: true});
    await fs.writeFile(this.#statePath, stateStr, 'utf8');
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
    let absFiles;
    try {
      absFiles = await glob(this.#script.output.values, {
        cwd: this.#script.packageDir,
        absolute: true,
        followSymlinks: false,
        includeDirectories: true,
        expandDirectories: true,
        throwIfOutsideCwd: true,
      });
    } catch (error) {
      if (error instanceof GlobOutsideCwdError) {
        // TODO(aomarks) It would be better to do this in the Analyzer by
        // looking at the output glob patterns. See
        // https://github.com/google/wireit/issues/64.
        throw new WireitError({
          script: this.#script,
          type: 'failure',
          reason: 'invalid-config-syntax',
          diagnostic: {
            severity: 'error',
            message: `Output files must be within the package: ${error.message}`,
            location: {
              file: this.#script.declaringFile,
              range: {
                offset: this.#script.output.node.offset,
                length: this.#script.output.node.length,
              },
            },
          },
        });
      }
      throw error;
    }
    if (absFiles.length === 0) {
      return;
    }
    await deleteEntries(absFiles);
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
      throw error;
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
