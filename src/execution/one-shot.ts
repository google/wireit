/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import * as fs from 'fs/promises';
import {createReadStream, createWriteStream} from 'fs';
import {WorkerPool} from '../util/worker-pool.js';
import {getScriptDataDir} from '../util/script-data-dir.js';
import {unreachable} from '../util/unreachable.js';
import {glob, GlobOutsideCwdError} from '../util/glob.js';
import {deleteEntries} from '../util/delete.js';
import {posixifyPathIfOnWindows} from '../util/windows.js';
import lockfile from 'proper-lockfile';
import {ScriptChildProcess} from '../script-child-process.js';
import {BaseExecution} from './base.js';
import {Fingerprint} from '../fingerprint.js';

import type {Result} from '../error.js';
import type {ExecutionResult} from './base.js';
import type {Executor} from '../executor.js';
import type {OneShotScriptConfig} from '../script.js';
import type {FingerprintString} from '../fingerprint.js';
import type {Logger} from '../logging/logger.js';
import type {WriteStream} from 'fs';
import type {Cache, CacheHit} from '../caching/cache.js';
import type {StartCancelled} from '../event.js';

type OneShotExecutionState = 'before-running' | 'running' | 'after-running';

/**
 * Execution for a {@link OneShotScriptConfig}.
 */
export class OneShotExecution extends BaseExecution<OneShotScriptConfig> {
  static execute(
    script: OneShotScriptConfig,
    executor: Executor,
    workerPool: WorkerPool,
    cache: Cache | undefined,
    logger: Logger
  ): Promise<ExecutionResult> {
    return new OneShotExecution(
      script,
      executor,
      workerPool,
      cache,
      logger
    ).#execute();
  }

  #state: OneShotExecutionState = 'before-running';
  readonly #cache?: Cache;
  readonly #workerPool: WorkerPool;

  private constructor(
    script: OneShotScriptConfig,
    executor: Executor,
    workerPool: WorkerPool,
    cache: Cache | undefined,
    logger: Logger
  ) {
    super(script, executor, logger);
    this.#workerPool = workerPool;
    this.#cache = cache;
  }

  #ensureState(state: OneShotExecutionState): void {
    if (this.#state !== state) {
      throw new Error(`Expected state ${state} but was ${this.#state}`);
    }
  }

  async #execute(): Promise<ExecutionResult> {
    this.#ensureState('before-running');

    const dependencyFingerprints = await this.executeDependencies();
    if (!dependencyFingerprints.ok) {
      dependencyFingerprints.error.push(this.#startCancelledEvent);
      return dependencyFingerprints;
    }

    // Significant time could have elapsed since we last checked because our
    // dependencies had to finish.
    if (this.#shouldNotStart) {
      return {ok: false, error: [this.#startCancelledEvent]};
    }

    return this.#acquireSystemLockIfNeeded(async () => {
      // Note we must wait for dependencies to finish before generating the
      // cache key, because a dependency could create or modify an input file to
      // this script, which would affect the key.
      const fingerprint = await Fingerprint.compute(
        this.script,
        dependencyFingerprints.value
      );
      if (await this.#fingerprintIsFresh(fingerprint)) {
        return this.#handleFresh(fingerprint);
      }

      // Computing the fingerprint can take some time, and the next operation is
      // destructive. Another good opportunity to check if we should still
      // start.
      if (this.#shouldNotStart) {
        return {ok: false, error: [this.#startCancelledEvent]};
      }

      const cacheHit = fingerprint.data.cacheable
        ? await this.#cache?.get(this.script, fingerprint)
        : undefined;
      if (this.#shouldNotStart) {
        return {ok: false, error: [this.#startCancelledEvent]};
      }
      if (cacheHit !== undefined) {
        return this.#handleCacheHit(cacheHit, fingerprint);
      }

      return this.#handleNeedsRun(fingerprint);
    });
  }

  /**
   * Whether we should return early instead of starting this script.
   *
   * We should check this as the first thing we do, and then after any
   * significant amount of time might have elapsed.
   */
  get #shouldNotStart(): boolean {
    return this.executor.shouldStopStartingNewScripts;
  }

  /**
   * Convenience to generate a cancellation failure event for this script.
   */
  get #startCancelledEvent(): StartCancelled {
    return {
      script: this.script,
      type: 'failure',
      reason: 'start-cancelled',
    };
  }

  /**
   * Acquire a system-wide lock on the execution of this script, if the script
   * has any output files that require it.
   */
  async #acquireSystemLockIfNeeded<T>(
    workFn: () => Promise<T>
  ): Promise<T | {ok: false; error: [StartCancelled]}> {
    if (this.script.output?.values.length === 0) {
      return workFn();
    }

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
        try {
          return await workFn();
        } finally {
          await release();
        }
      } catch (error) {
        if ((error as {code: string}).code === 'ELOCKED') {
          if (!loggedLocked) {
            // Only log this once.
            this.logger.log({
              script: this.script,
              type: 'info',
              detail: 'locked',
            });
            loggedLocked = true;
          }
          // Wait a moment before attempting to acquire the lock again.
          await new Promise((resolve) => setTimeout(resolve, 200));
          if (this.#shouldNotStart) {
            return {ok: false, error: [this.#startCancelledEvent]};
          }
        } else {
          throw error;
        }
      }
    }
  }

  /**
   * Check whether the given fingerprint matches the current one from the
   * `.wireit` directory.
   */
  async #fingerprintIsFresh(fingerprint: Fingerprint): Promise<boolean> {
    if (!fingerprint.data.cacheable) {
      return false;
    }
    const prevFingerprint = await this.#readPreviousFingerprint();
    return prevFingerprint !== undefined && fingerprint.equal(prevFingerprint);
  }

  /**
   * Handle the outcome where the script is already fresh.
   */
  async #handleFresh(fingerprint: Fingerprint): Promise<ExecutionResult> {
    // TODO(aomarks) Does not preserve original order of stdout vs stderr
    // chunks. See https://github.com/google/wireit/issues/74.
    await Promise.all([
      this.#replayStdoutIfPresent(),
      this.#replayStderrIfPresent(),
    ]);
    this.logger.log({
      script: this.script,
      type: 'success',
      reason: 'fresh',
    });
    return {ok: true, value: fingerprint};
  }

  /**
   * Handle the outcome where the script was stale and we got a cache hit.
   */
  async #handleCacheHit(
    cacheHit: CacheHit,
    fingerprint: Fingerprint
  ): Promise<ExecutionResult> {
    // Delete the fingerprint file and stdio replay files. It's important we do
    // this before restoring from cache, because we don't want to think that the
    // previous fingerprint is still valid when it no longer is.
    await this.#prepareDataDir();

    // If we are restoring from cache, we should always delete existing output.
    // The purpose of "clean:false" and "clean:if-file-deleted" is to allow
    // tools with incremental build (like tsc --build) to work.
    //
    // However, this only applies when the tool is able to observe each
    // incremental change to the input files. When we restore from cache, we are
    // directly replacing the output files, and not invoking the tool at all, so
    // there is no way for the tool to do any cleanup.
    await this.#cleanOutput();

    await cacheHit.apply();
    this.#state = 'after-running';

    // We include stdout and stderr replay files when we save to the cache, so
    // if there were any, they will now be in place.
    // TODO(aomarks) Does not preserve original order of stdout vs stderr
    // chunks. See https://github.com/google/wireit/issues/74.
    await Promise.all([
      this.#replayStdoutIfPresent(),
      this.#replayStderrIfPresent(),
    ]);

    await this.#writeFingerprintFile(fingerprint);

    this.logger.log({
      script: this.script,
      type: 'success',
      reason: 'cached',
    });

    return {ok: true, value: fingerprint};
  }

  /**
   * Handle the outcome where the script was stale and we need to run it.
   */
  async #handleNeedsRun(fingerprint: Fingerprint): Promise<ExecutionResult> {
    // Check if we should clean before we delete the fingerprint file, because
    // we sometimes need to read the previous fingerprint file to determine
    // this.
    const shouldClean = await this.#shouldClean(fingerprint);

    // Delete the fingerprint file and stdio replay files. It's important we do
    // this before starting the command, because we don't want to think that the
    // previous fingerprint is still valid when it no longer is.
    await this.#prepareDataDir();

    if (shouldClean) {
      const result = await this.#cleanOutput();
      if (!result.ok) {
        return {ok: false, error: [result.error]};
      }
    }

    const childResult = await this.#workerPool.run(async () => {
      // Significant time could have elapsed since we last checked because of
      // parallelism limits.
      if (this.#shouldNotStart) {
        return {ok: false, error: this.#startCancelledEvent};
      }

      this.#state = 'running';
      this.logger.log({
        script: this.script,
        type: 'info',
        detail: 'running',
      });

      const child = new ScriptChildProcess(
        // Unfortunately TypeScript doesn't automatically narrow this type
        // based on the undefined-command check we did just above.
        this.script
      );

      void this.executor.shouldKillRunningScripts.then(() => {
        child.kill();
      });

      // Only create the stdout/stderr replay files if we encounter anything on
      // this streams.
      let stdoutReplay: WriteStream | undefined;
      let stderrReplay: WriteStream | undefined;

      child.stdout.on('data', (data: string | Buffer) => {
        this.logger.log({
          script: this.script,
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
        this.logger.log({
          script: this.script,
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
          this.logger.log({
            script: this.script,
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
          this.executor.notifyFailure();
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

    this.#state = 'after-running';

    if (!childResult.ok) {
      return {ok: false, error: [childResult.error]};
    }

    await this.#writeFingerprintFile(fingerprint);
    this.#state = 'after-running';

    if (fingerprint.data.cacheable) {
      const result = await this.#saveToCacheIfPossible(fingerprint);
      if (!result.ok) {
        return {ok: false, error: [result.error]};
      }
    }

    return {ok: true, value: fingerprint};
  }

  async #shouldClean(fingerprint: Fingerprint) {
    const cleanValue = this.script.clean;
    switch (cleanValue) {
      case true: {
        return true;
      }
      case false: {
        return false;
      }
      case 'if-file-deleted': {
        const prevFingerprint = await this.#readPreviousFingerprint();
        if (prevFingerprint === undefined) {
          // If we don't know the previous fingerprint, then we can't know
          // whether any input files were removed. It's safer to err on the
          // side of cleaning.
          return true;
        }
        return this.#anyInputFilesDeletedSinceLastRun(
          fingerprint,
          prevFingerprint
        );
      }
      default: {
        throw new Error(
          `Unhandled clean setting: ${unreachable(cleanValue) as string}`
        );
      }
    }
  }

  /**
   * Compares the current set of input file names to the previous set of input
   * file names, and returns whether any files have been removed.
   */
  #anyInputFilesDeletedSinceLastRun(
    curFingerprint: Fingerprint,
    prevFingerprint: Fingerprint
  ): boolean {
    const curFiles = Object.keys(curFingerprint.data.files);
    const prevFiles = Object.keys(prevFingerprint.data.files);
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

  /**
   * Save the current output files to the configured cache if possible.
   */
  async #saveToCacheIfPossible(
    fingerprint: Fingerprint
  ): Promise<Result<void>> {
    if (this.#cache === undefined || this.script.output === undefined) {
      return {ok: true, value: undefined};
    }
    let paths;
    try {
      paths = await glob(
        [
          ...this.script.output.values,
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
            pathlib.relative(this.script.packageDir, this.#stdoutReplayPath)
          ),
          posixifyPathIfOnWindows(
            pathlib.relative(this.script.packageDir, this.#stderrReplayPath)
          ),
        ],
        {
          cwd: this.script.packageDir,
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
            script: this.script,
            diagnostic: {
              severity: 'error',
              message: `Output files must be within the package: ${error.message}`,
              location: {
                file: this.script.declaringFile,
                range: {
                  offset: this.script.output.node.offset,
                  length: this.script.output.node.length,
                },
              },
            },
          },
        };
      }
      throw error;
    }
    await this.#cache.set(this.script, fingerprint, paths);
    return {ok: true, value: undefined};
  }

  /**
   * Get the directory name where Wireit data can be saved for this script.
   */
  get #dataDir(): string {
    return getScriptDataDir(this.script);
  }

  /**
   * Get the path where the current fingerprint is saved for this script.
   */
  get #fingerprintFilePath(): string {
    return pathlib.join(this.#dataDir, 'fingerprint');
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
   * Read this script's previous fingerprint from `fingerprint` file in the
   * `.wireit` directory. Cached after first call.
   */
  async #readPreviousFingerprint(): Promise<Fingerprint | undefined> {
    if (this.#cachedPreviousFingerprint === undefined) {
      this.#cachedPreviousFingerprint = (async () => {
        try {
          return Fingerprint.fromString(
            (await fs.readFile(
              this.#fingerprintFilePath,
              'utf8'
            )) as FingerprintString
          );
        } catch (error) {
          if ((error as {code?: string}).code === 'ENOENT') {
            return undefined;
          }
          throw error;
        }
      })();
    }
    return this.#cachedPreviousFingerprint;
  }
  #cachedPreviousFingerprint?: Promise<Fingerprint | undefined>;

  /**
   * Write this script's fingerprint file.
   */
  async #writeFingerprintFile(fingerprint: Fingerprint): Promise<void> {
    await fs.mkdir(this.#dataDir, {recursive: true});
    await fs.writeFile(this.#fingerprintFilePath, fingerprint.string, 'utf8');
  }

  /**
   * Delete the fingerprint file and any stdio replays for this script from the
   * previous run, and ensure the data directory exists.
   */
  async #prepareDataDir(): Promise<void> {
    await Promise.all([
      fs.rm(this.#fingerprintFilePath, {force: true}),
      fs.rm(this.#stdoutReplayPath, {force: true}),
      fs.rm(this.#stderrReplayPath, {force: true}),
      fs.mkdir(this.#dataDir, {recursive: true}),
    ]);
  }

  /**
   * Delete all files matched by this script's "output" glob patterns.
   */
  async #cleanOutput(): Promise<Result<void>> {
    if (this.script.output === undefined) {
      return {ok: true, value: undefined};
    }
    let absFiles;
    try {
      absFiles = await glob(this.script.output.values, {
        cwd: this.script.packageDir,
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
            script: this.script,
            diagnostic: {
              severity: 'error',
              message: `Output files must be within the package: ${error.message}`,
              location: {
                file: this.script.declaringFile,
                range: {
                  offset: this.script.output.node.offset,
                  length: this.script.output.node.length,
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
        this.logger.log({
          script: this.script,
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
        this.logger.log({
          script: this.script,
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
