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

import type {Result} from '../error.js';
import type {ExecutionResult} from './base.js';
import type {Executor} from '../executor.js';
import type {
  ScriptConfig,
  ScriptReference,
  Fingerprint,
  FingerprintString,
} from '../script.js';
import type {Logger} from '../logging/logger.js';
import type {WriteStream} from 'fs';
import type {Cache} from '../caching/cache.js';
import type {StartCancelled} from '../event.js';

/**
 * A script with a command that exits by itself.
 */
export type OneShotScriptConfig = ScriptConfig & {
  command: Exclude<ScriptConfig['command'], undefined>;
};

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

  async #execute(): Promise<ExecutionResult> {
    if (this.#shouldNotStart) {
      return {ok: false, error: [this.#startCancelledEvent]};
    }
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

    if (this.script.output?.values.length === 0) {
      // If there are explicitly no output files, then it's not actually
      // important to maintain an exclusive lock.
      return this.#executeScript(dependencyFingerprints.value);
    }
    const releaseLock = await this.#acquireLock();
    if (!releaseLock.ok) {
      return {ok: false, error: [releaseLock.error]};
    }
    try {
      return await this.#executeScript(dependencyFingerprints.value);
    } finally {
      await releaseLock.value();
    }
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
   * Acquire a system-wide lock on the execution of this script.
   */
  async #acquireLock(): Promise<Result<() => Promise<void>, StartCancelled>> {
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
            return {ok: false, error: this.#startCancelledEvent};
          }
        } else {
          throw error;
        }
      }
    }
  }

  async #executeScript(
    dependencyFingerprints: Array<[ScriptReference, Fingerprint]>
  ): Promise<ExecutionResult> {
    // Note we must wait for dependencies to finish before generating the cache
    // key, because a dependency could create or modify an input file to this
    // script, which would affect the key.
    const fingerprintData = await this.computeFingerprint(
      dependencyFingerprints
    );
    const fingerprint = JSON.stringify(fingerprintData) as FingerprintString;
    const prevFingerprint = await this.#readPreviousFingerprint();
    if (
      fingerprintData.cacheable &&
      prevFingerprint !== undefined &&
      prevFingerprint === fingerprint
    ) {
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
      return {ok: true, value: fingerprintData};
    }

    // Computing the fingerprint can take some time, and the next operation is
    // destructive. Another good opportunity to check if we should still start.
    if (this.#shouldNotStart) {
      return {ok: false, error: [this.#startCancelledEvent]};
    }

    // It's important that we delete the previous fingerprint and stdio replay
    // files before running the command or restoring from cache, because if
    // either fails mid-flight, we don't want to think that the previous
    // fingerprint is still valid.
    await this.#prepareDataDir();

    const cacheHit = fingerprintData.cacheable
      ? await this.#cache?.get(this.script, fingerprint)
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
      const cleanValue = this.script.clean;
      switch (cleanValue) {
        case true: {
          return true;
        }
        case false: {
          return false;
        }
        case 'if-file-deleted': {
          if (prevFingerprint === undefined) {
            // If we don't know the previous fingerprint, then we can't know
            // whether any input files were removed. It's safer to err on the
            // side of cleaning.
            return true;
          }
          return this.#anyInputFilesDeletedSinceLastRun(
            fingerprintData,
            JSON.parse(prevFingerprint) as Fingerprint
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
      this.logger.log({
        script: this.script,
        type: 'success',
        reason: 'cached',
      });
    } else {
      const result = await this.#spawnCommand();
      if (!result.ok) {
        return {ok: false, error: [result.error]};
      }
    }

    // TODO(aomarks) We don't technically need to wait for these to finish to
    // return, we only need to wait in the top-level call to execute. The same
    // will go for saving output to the cache.
    await this.#writeFingerprintFile(fingerprint);
    if (cacheHit === undefined && fingerprintData.cacheable) {
      const result = await this.#saveToCacheIfPossible(fingerprint);
      if (!result.ok) {
        return {ok: false, error: [result.error]};
      }
    }

    return {ok: true, value: fingerprintData};
  }

  /**
   * Compares the current set of input file names to the previous set of input
   * file names, and returns whether any files have been removed.
   */
  #anyInputFilesDeletedSinceLastRun(
    curState: Fingerprint,
    prevState: Fingerprint
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

  async #spawnCommand(): Promise<Result<void>> {
    return this.#workerPool.run(async (): Promise<Result<void>> => {
      // Significant time could have elapsed since we last checked because of
      // parallelism limits.
      if (this.#shouldNotStart) {
        return {ok: false, error: this.#startCancelledEvent};
      }

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
  }

  /**
   * Save the current output files to the configured cache if possible.
   */
  async #saveToCacheIfPossible(
    fingerprint: FingerprintString
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
   * Read this script's fingerprint file.
   */
  async #readPreviousFingerprint(): Promise<FingerprintString | undefined> {
    try {
      return (await fs.readFile(
        this.#fingerprintFilePath,
        'utf8'
      )) as FingerprintString;
    } catch (error) {
      if ((error as {code?: string}).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Write this script's fingerprint file.
   */
  async #writeFingerprintFile(fingerprint: FingerprintString): Promise<void> {
    await fs.mkdir(this.#dataDir, {recursive: true});
    await fs.writeFile(this.#fingerprintFilePath, fingerprint, 'utf8');
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
