/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ScriptExecution} from './execution/one-shot.js';
import {scriptReferenceToString} from './script.js';
import {WorkerPool} from './util/worker-pool.js';
import {Deferred} from './util/deferred.js';

import type {ExecutionResult} from './execution/one-shot.js';
import type {ScriptConfig} from './script.js';
import type {Logger} from './logging/logger.js';
import type {Cache} from './caching/cache.js';

/**
 * What to do when a script failure occurs:
 *
 * - `no-new`: Allow running scripts to finish, but don't start new ones.
 * - `continue`: Allow running scripts to finish, and start new ones unless a
 *   dependency failed.
 * - `kill`: Immediately kill running scripts, and don't start new ones.
 */
export type FailureMode = 'no-new' | 'continue' | 'kill';

/**
 * Executes a script that has been analyzed and validated by the Analyzer.
 */
export class Executor {
  readonly #executions = new Map<string, Promise<ExecutionResult>>();
  readonly #logger: Logger;
  readonly #workerPool: WorkerPool;
  readonly #cache?: Cache;

  /** Resolves when the first failure occurs in any script. */
  readonly #failureOccured = new Deferred<void>();
  /** Resolves when we decide that new scripts should not be started. */
  readonly #stopStartingNewScripts = new Deferred<void>();
  /** Resolves when we decide that running scripts should be killed. */
  readonly #killRunningScripts = new Deferred<void>();

  constructor(
    logger: Logger,
    workerPool: WorkerPool,
    cache: Cache | undefined,
    failureMode: FailureMode,
    abort: Deferred<void>
  ) {
    this.#logger = logger;
    this.#workerPool = workerPool;
    this.#cache = cache;

    // If this entire execution is aborted because e.g. the user sent a SIGINT
    // to the Wireit process, then dont start new scripts, and kill running
    // ones.
    void abort.promise.then(() => {
      this.#stopStartingNewScripts.resolve();
      this.#killRunningScripts.resolve();
    });

    // If a failure occurs, then whether we stop starting new scripts or kill
    // running ones depends on the failure mode setting.
    void this.#failureOccured.promise.then(() => {
      switch (failureMode) {
        case 'continue': {
          break;
        }
        case 'no-new': {
          this.#stopStartingNewScripts.resolve();
          break;
        }
        case 'kill': {
          this.#stopStartingNewScripts.resolve();
          this.#killRunningScripts.resolve();
          break;
        }
        default: {
          const never: never = failureMode;
          throw new Error(
            `Internal error: unexpected failure mode: ${String(never)}`
          );
        }
      }
    });
  }

  /**
   * Signal that a script has failed, which will potentially stop starting or
   * kill other scripts depending on the {@link FailureMode}.
   *
   * This method will be called automatically in the normal flow of execution,
   * but scripts can also call it directly to synchronously signal a failure.
   */
  notifyFailure(): void {
    this.#failureOccured.resolve();
  }

  /**
   * Synchronously check if new scripts should stop being started.
   */
  get shouldStopStartingNewScripts(): boolean {
    return this.#stopStartingNewScripts.settled;
  }

  /**
   * A promise which resolves if we should kill running scripts.
   */
  get shouldKillRunningScripts(): Promise<void> {
    return this.#killRunningScripts.promise;
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
        this.#logger
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
