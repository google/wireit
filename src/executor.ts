/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {NoCommandScriptExecution} from './execution/no-command.js';
import {StandardScriptExecution} from './execution/standard.js';
import {ServiceScriptExecution} from './execution/service.js';
import {ScriptReferenceString, scriptReferenceToString} from './config.js';
import {WorkerPool} from './util/worker-pool.js';
import {Deferred} from './util/deferred.js';

import type {Logger} from './logging/logger.js';
import type {Cache} from './caching/cache.js';
import type {
  ScriptConfig,
  NoCommandScriptConfig,
  ServiceScriptConfig,
  StandardScriptConfig,
} from './config.js';
import type {Result} from './error.js';
import type {Failure} from './event.js';

type Execution =
  | NoCommandScriptExecution
  | StandardScriptExecution
  | ServiceScriptExecution;

type ConfigToExecution<T extends ScriptConfig> = T extends NoCommandScriptConfig
  ? NoCommandScriptExecution
  : T extends StandardScriptConfig
  ? StandardScriptExecution
  : T extends ServiceScriptConfig
  ? ServiceScriptExecution
  : never;

export type ServiceMap = Map<ScriptReferenceString, ServiceScriptExecution>;

/**
 * What to do when a script failure occurs:
 *
 * - `no-new`: Allow running scripts to finish, but don't start new ones.
 * - `continue`: Allow running scripts to finish, and start new ones unless a
 *   dependency failed.
 * - `kill`: Immediately kill running scripts, and don't start new ones.
 */
export type FailureMode = 'no-new' | 'continue' | 'kill';

let executorConstructorHook: ((executor: Executor) => void) | undefined;

/**
 * For GC testing only. A function that is called whenever an Executor is
 * constructed.
 */
export function registerExecutorConstructorHook(
  fn: typeof executorConstructorHook
) {
  executorConstructorHook = fn;
}

/**
 * Executes a script that has been analyzed and validated by the Analyzer.
 */
export class Executor {
  private readonly _rootConfig: ScriptConfig;
  private readonly _executions = new Map<ScriptReferenceString, Execution>();
  private readonly _persistentServices: ServiceMap = new Map();
  private readonly _ephemeralServices: ServiceScriptExecution[] = [];
  private readonly _previousIterationServices: ServiceMap | undefined;
  private readonly _logger: Logger;
  private readonly _workerPool: WorkerPool;
  private readonly _cache?: Cache;

  /** Resolves when the first failure occurs in any script. */
  private readonly _failureOccured = new Deferred<void>();
  /** Resolves when we decide that new scripts should not be started. */
  private readonly _stopStartingNewScripts = new Deferred<void>();
  /** Resolves when we decide that running scripts should be killed. */
  private readonly _killRunningScripts = new Deferred<void>();
  /** Resolves when we decide that services should be stopped. */
  private readonly _stopServices = new Deferred<void>();

  constructor(
    rootConfig: ScriptConfig,
    logger: Logger,
    workerPool: WorkerPool,
    cache: Cache | undefined,
    failureMode: FailureMode,
    abort: Deferred<void>,
    previousIterationServices: ServiceMap | undefined
  ) {
    executorConstructorHook?.(this);
    this._rootConfig = rootConfig;
    this._logger = logger;
    this._workerPool = workerPool;
    this._cache = cache;
    this._previousIterationServices = previousIterationServices;

    // If this entire execution is aborted because e.g. the user sent a SIGINT
    // to the Wireit process, then dont start new scripts, and kill running
    // ones.
    void abort.promise.then(() => {
      this._stopStartingNewScripts.resolve();
      this._killRunningScripts.resolve();
      this._stopServices.resolve();
    });

    // If a failure occurs, then whether we stop starting new scripts or kill
    // running ones depends on the failure mode setting.
    void this._failureOccured.promise.then(() => {
      // Services should stop in any mode.
      this._stopServices.resolve();
      switch (failureMode) {
        case 'continue': {
          break;
        }
        case 'no-new': {
          this._stopStartingNewScripts.resolve();
          break;
        }
        case 'kill': {
          this._stopStartingNewScripts.resolve();
          this._killRunningScripts.resolve();
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
   * Execute the root script.
   */
  async execute(): Promise<Result<ServiceMap, Failure[]>> {
    if (
      this._previousIterationServices !== undefined &&
      this._previousIterationServices.size > 0
    ) {
      // If any services were removed from the graph entirely, or used to be
      // persistent but are no longer, then stop them now.
      const currentPersistentServices = new Set<ScriptReferenceString>();
      for (const script of findAllScripts(this._rootConfig)) {
        if (script.service && script.isPersistent) {
          currentPersistentServices.add(scriptReferenceToString(script));
        }
      }
      const abortPromises = [];
      for (const [key, service] of this._previousIterationServices) {
        if (!currentPersistentServices.has(key)) {
          abortPromises.push(service.abort());
          this._previousIterationServices.delete(key);
        }
      }
      await Promise.all(abortPromises);
    }

    const errors: Failure[] = [];
    const rootExecutionResult = await this.getExecution(
      this._rootConfig
    ).execute();
    if (!rootExecutionResult.ok) {
      errors.push(...rootExecutionResult.error);
    }
    const ephemeralServiceResults = await Promise.all(
      this._ephemeralServices.map((service) => service.terminated)
    );
    for (const result of ephemeralServiceResults) {
      if (!result.ok) {
        errors.push(result.error);
      }
    }
    if (errors.length > 0) {
      return {ok: false, error: errors};
    }
    return {ok: true, value: this._persistentServices};
  }

  /**
   * Signal that a script has failed, which will potentially stop starting or
   * kill other scripts depending on the {@link FailureMode}.
   *
   * This method will be called automatically in the normal flow of execution,
   * but scripts can also call it directly to synchronously signal a failure.
   */
  notifyFailure(): void {
    this._failureOccured.resolve();
  }

  /**
   * Synchronously check if new scripts should stop being started.
   */
  get shouldStopStartingNewScripts(): boolean {
    return this._stopStartingNewScripts.settled;
  }

  /**
   * A promise which resolves if we should kill running scripts.
   */
  get shouldKillRunningScripts(): Promise<void> {
    return this._killRunningScripts.promise;
  }

  /**
   * Get the execution instance for a script config, creating one if it doesn't
   * already exist.
   */
  getExecution<T extends ScriptConfig>(config: T): ConfigToExecution<T> {
    const key = scriptReferenceToString(config);
    let execution = this._executions.get(key);
    if (execution === undefined) {
      if (config.command === undefined) {
        execution = new NoCommandScriptExecution(config, this, this._logger);
      } else if (config.service) {
        execution = new ServiceScriptExecution(
          config,
          this,
          this._logger,
          this._stopServices.promise,
          this._previousIterationServices?.get(key)
        );
        if (config.isPersistent) {
          this._persistentServices.set(key, execution);
        } else {
          this._ephemeralServices.push(execution);
        }
      } else {
        execution = new StandardScriptExecution(
          config,
          this,
          this._workerPool,
          this._cache,
          this._logger
        );
      }
      this._executions.set(key, execution);
    }
    // Cast needed because our Map type doesn't know about the config ->
    // execution type guarantees. We could make a smarter Map type, but not
    // really worth it here.
    return execution as ConfigToExecution<T>;
  }
}

/**
 * Walk the dependencies of the given root script and return all scripts in the
 * graph (including the root itself).
 */
function findAllScripts(root: ScriptConfig): Set<ScriptConfig> {
  const visited = new Set<ScriptConfig>();
  const stack = [root];
  while (stack.length > 0) {
    const next = stack.pop()!;
    visited.add(next);
    for (const dep of next.dependencies) {
      if (!visited.has(dep.config)) {
        stack.push(dep.config);
      }
    }
  }
  return visited;
}
