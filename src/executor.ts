/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import * as fs from 'fs/promises';
import {createHash} from 'crypto';
import {createReadStream, createWriteStream} from 'fs';
import {Result} from './error.js';
import {scriptReferenceToString} from './script.js';
import {shuffle} from './util/shuffle.js';
import {WorkerPool} from './util/worker-pool.js';
import {getScriptDataDir} from './util/script-data-dir.js';
import {unreachable} from './util/unreachable.js';
import {glob, GlobOutsideCwdError} from './util/glob.js';
import {deleteEntries} from './util/delete.js';
import {posixifyPathIfOnWindows} from './util/windows.js';
import lockfile from 'proper-lockfile';
import {ScriptChildProcess} from './script-child-process.js';
import {Deferred} from './util/deferred.js';

import type {
  ScriptConfig,
  ScriptConfigWithRequiredCommand,
  ScriptReference,
  ScriptReferenceString,
  ScriptState,
  ScriptStateString,
  Sha256HexDigest,
} from './script.js';
import type {Logger} from './logging/logger.js';
import type {WriteStream} from 'fs';
import type {Cache} from './caching/cache.js';
import type {Failure, Cancelled} from './event.js';

type ExecutionResult = Result<ScriptState, Failure[]>;

/**
 * What to do when a script failure occurs:
 *
 * - `no-new`: Allow running scripts to finish, but don't start new ones.
 * - `continue`: Allow running scripts to finish, and start new ones unless a
 *   dependency failed.
 */
export type FailureMode = 'no-new' | 'continue';

/**
 * Executes a script that has been analyzed and validated by the Analyzer.
 */
export class Executor {
  readonly #executions = new Map<string, Promise<ExecutionResult>>();
  readonly #logger: Logger;
  readonly #workerPool: WorkerPool;
  readonly #cache?: Cache;
  readonly #failureMode: FailureMode;
  readonly #failureDeferred = new Deferred<void>();

  constructor(
    logger: Logger,
    workerPool: WorkerPool,
    cache: Cache | undefined,
    failureMode: FailureMode
  ) {
    this.#logger = logger;
    this.#workerPool = workerPool;
    this.#cache = cache;
    this.#failureMode = failureMode;
  }

  notifyFailure(): void {
    this.#failureDeferred.resolve();
  }

  get failureEncountered(): boolean {
    return this.#failureDeferred.settled;
  }

  async execute(script: ScriptConfig): Promise<ExecutionResult> {
    const executionKey = scriptReferenceToString(script);
    let promise = this.#executions.get(executionKey);
    if (promise === undefined) {
      promise = ScriptExecution.execute(
        script,
        this,
        this.#workerPool,
        this.#cache,
        this.#logger,
        this.#failureMode
      ).then((result) => {
        if (!result.ok) {
          this.notifyFailure();
        }
        return result;
      });
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
    logger: Logger,
    failureMode: FailureMode
  ): Promise<ExecutionResult> {
    return new ScriptExecution(
      script,
      executor,
      workerPool,
      cache,
      logger,
      failureMode
    ).#execute();
  }

  readonly #script: ScriptConfig;
  readonly #executor: Executor;
  readonly #cache?: Cache;
  readonly #workerPool: WorkerPool;
  readonly #logger: Logger;
  readonly #failureMode: FailureMode;

  private constructor(
    script: ScriptConfig,
    executor: Executor,
    workerPool: WorkerPool,
    cache: Cache | undefined,
    logger: Logger,
    failureMode: FailureMode
  ) {
    this.#script = script;
    this.#executor = executor;
    this.#workerPool = workerPool;
    this.#cache = cache;
    this.#logger = logger;
    this.#failureMode = failureMode;
  }

  async #execute(): Promise<ExecutionResult> {
    if (this.#shouldCancel) {
      return {ok: false, error: [this.#cancelledEvent]};
    }
    const dependencyStatesResult = await this.#executeDependencies();
    if (!dependencyStatesResult.ok) {
      dependencyStatesResult.error.push(this.#cancelledEvent);
      return dependencyStatesResult;
    }

    // Significant time could have elapsed since we last checked because our
    // dependencies had to finish.
    if (this.#shouldCancel) {
      return {ok: false, error: [this.#cancelledEvent]};
    }

    if (this.#script.output?.values.length === 0) {
      // If there are explicitly no output files, then it's not actually
      // important to maintain an exclusive lock.
      return this.#executeScript(dependencyStatesResult.value);
    }
    const releaseLock = await this.#acquireLock();
    if (!releaseLock.ok) {
      return {ok: false, error: [releaseLock.error]};
    }
    try {
      return await this.#executeScript(dependencyStatesResult.value);
    } finally {
      await releaseLock.value();
    }
  }

  /**
   * Whether we should cancel execution of this script before we start it.
   *
   * We should check this as the first thing we do, and then after any
   * significant amount of time might have elapsed.
   */
  get #shouldCancel(): boolean {
    if (!this.#executor.failureEncountered) {
      return false;
    }
    switch (this.#failureMode) {
      case 'continue': {
        return false;
      }
      case 'no-new': {
        return true;
      }
      default: {
        const never: never = this.#failureMode;
        throw new Error(
          `Internal error: unexpected failure mode: ${String(never)}`
        );
      }
    }
  }

  /**
   * Convenience to generate a cancellation failure event for this script.
   */
  get #cancelledEvent(): Cancelled {
    return {
      script: this.#script,
      type: 'failure',
      reason: 'cancelled',
    };
  }

  /**
   * Acquire a system-wide lock on the execution of this script.
   */
  async #acquireLock(): Promise<Result<() => Promise<void>, Cancelled>> {
    // The proper-lockfile library is designed to give an exclusive lock for a
    // *file*. That's slightly misaligned with our use-case, because there's no
    // particular file we need a lock for -- our lock is for the execution of
    // this script.
    //
    // We can still use the library, we just need to pick some arbitrary file to
    // ask it to lock for us. It actually errors if the file doesn't exist. So
    // we end up with a mostly pointless file, and an adjacent "<file>.lock"
    // directory that manages the lock (to acquire a lock, it does a mkdir for
    // "<file>.lock", which will atomically succeed or fail depending on whether
    // it already existed).
    //
    // TODO(aomarks) We could make our own implementation that directly takes a
    // directory to mkdir and doesn't care about the file. There are some nice
    // details proper-lockfile handles.
    const lockFile = pathlib.join(this.#dataDir, 'lock');
    await fs.mkdir(pathlib.dirname(lockFile), {recursive: true});
    await fs.writeFile(lockFile, '');
    let loggedLocked = false;
    while (true) {
      try {
        const release = await lockfile.lock(lockFile, {
          // If this many milliseconds has elapsed since the lock mtime was last
          // updated, proper-lockfile will delete it and attempt to acquire the
          // lock again. This handles the case where a process holding the lock
          // hard-crashed.
          stale: 10_000,
          // How frequently the mtime for the lock will be updated while it is
          // being held. This should be some smallish factor of "stale" so that
          // we're unlikely to appear stale when we're actually still working on
          // the script.
          update: 2000,
        });
        return {ok: true, value: release};
      } catch (error) {
        if ((error as {code: string}).code === 'ELOCKED') {
          if (!loggedLocked) {
            // Only log this once.
            this.#logger.log({
              script: this.#script,
              type: 'info',
              detail: 'locked',
            });
            loggedLocked = true;
          }
          // Wait a moment before attempting to acquire the lock again.
          await new Promise((resolve) => setTimeout(resolve, 200));
          if (this.#shouldCancel) {
            return {ok: false, error: this.#cancelledEvent};
          }
        } else {
          throw error;
        }
      }
    }
  }

  async #executeScript(
    dependencyStates: Array<[ScriptReference, ScriptState]>
  ): Promise<ExecutionResult> {
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
      return {ok: true, value: state};
    }

    // Computing state can take some time, and the next operation is
    // destructive. Another good opportunity to check if we're cancelled.
    if (this.#shouldCancel) {
      return {ok: false, error: [this.#cancelledEvent]};
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
      const result = await this.#cleanOutput();
      if (!result.ok) {
        return {ok: false, error: [result.error]};
      }
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
      const result = await this.#spawnCommandIfNeeded();
      if (!result.ok) {
        return {ok: false, error: [result.error]};
      }
    }

    // TODO(aomarks) We don't technically need to wait for these to finish to
    // return, we only need to wait in the top-level call to execute. The same
    // will go for saving output to the cache.
    await this.#writeStateFile(stateStr);
    if (cacheHit === undefined && state.cacheable) {
      const result = await this.#saveToCacheIfPossible(stateStr);
      if (!result.ok) {
        return {ok: false, error: [result.error]};
      }
    }

    return {ok: true, value: state};
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

  async #executeDependencies(): Promise<
    Result<Array<[ScriptReference, ScriptState]>, Failure[]>
  > {
    // Randomize the order we execute dependencies to make it less likely for a
    // user to inadvertently depend on any specific order, which could indicate
    // a missing edge in the dependency graph.
    shuffle(this.#script.dependencies);
    // Note we use Promise.allSettled instead of Promise.all so that we can
    // collect all errors, instead of just the first one.
    const dependencyResults = await Promise.allSettled(
      this.#script.dependencies.map((dependency) => {
        return this.#executor.execute(dependency);
      })
    );
    const errors = new Set<Failure>();
    const results: Array<[ScriptReference, ScriptState]> = [];
    for (let i = 0; i < dependencyResults.length; i++) {
      const result = dependencyResults[i];
      if (result.status === 'rejected') {
        const error: unknown = result.reason;
        errors.add({
          type: 'failure',
          reason: 'unknown-error-thrown',
          script: this.#script.dependencies[i],
          error: error,
        });
      } else {
        if (!result.value.ok) {
          for (const error of result.value.error) {
            errors.add(error);
          }
        } else {
          results.push([this.#script.dependencies[i], result.value.value]);
        }
      }
    }
    if (errors.size > 0) {
      return {ok: false, error: [...errors]};
    }
    return {ok: true, value: results};
  }

  async #spawnCommandIfNeeded(): Promise<Result<void>> {
    // It's valid to not have a command defined, since thats a useful way to
    // alias a group of dependency scripts. In this case, we can return early.
    if (!this.#script.command) {
      this.#logger.log({
        script: this.#script,
        type: 'success',
        reason: 'no-command',
      });
      return {ok: true, value: undefined};
    }

    return this.#workerPool.run(async (): Promise<Result<void>> => {
      // Significant time could have elapsed since we last checked because of
      // parallelism limits.
      if (this.#shouldCancel) {
        return {ok: false, error: this.#cancelledEvent};
      }

      this.#logger.log({
        script: this.#script,
        type: 'info',
        detail: 'running',
      });

      const child = new ScriptChildProcess(
        // Unfortunately TypeScript doesn't automatically narrow this type
        // based on the undefined-command check we did just above.
        this.#script as ScriptConfigWithRequiredCommand
      );

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

      try {
        const result = await child.completed;
        if (result.ok) {
          this.#logger.log({
            script: this.#script,
            type: 'success',
            reason: 'exit-zero',
          });
        } else {
          // This failure will propagate to the Executor eventually anyway, but
          // asynchronously.
          //
          // The problem with that is that when parallelism is constrained, the
          // next script waiting on this WorkerPool might start running before
          // the failure information propagates, because returning from this
          // function immediately unblocks the next worker.
          //
          // By directly notifying the Executor about the failure while we are
          // still inside the WorkerPool callback, we prevent this race
          // condition.
          this.#executor.notifyFailure();
        }
        return result;
      } finally {
        if (stdoutReplay !== undefined) {
          await closeWriteStream(stdoutReplay);
        }
        if (stderrReplay !== undefined) {
          await closeWriteStream(stderrReplay);
        }
      }
    });
  }

  /**
   * Save the current output files to the configured cache if possible.
   */
  async #saveToCacheIfPossible(
    stateStr: ScriptStateString
  ): Promise<Result<void>> {
    if (this.#cache === undefined || this.#script.output === undefined) {
      return {ok: true, value: undefined};
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
        return {
          ok: false,
          error: {
            type: 'failure',
            reason: 'invalid-config-syntax',
            script: this.#script,
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
          },
        };
      }
      throw error;
    }
    await this.#cache.set(this.#script, stateStr, paths);
    return {ok: true, value: undefined};
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
  async #cleanOutput(): Promise<Result<void>> {
    if (this.#script.output === undefined) {
      return {ok: true, value: undefined};
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
        return {
          ok: false,
          error: {
            type: 'failure',
            reason: 'invalid-config-syntax',
            script: this.#script,
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
          },
        };
      }
      throw error;
    }
    if (absFiles.length === 0) {
      return {ok: true, value: undefined};
    }
    await deleteEntries(absFiles);
    return {ok: true, value: undefined};
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
