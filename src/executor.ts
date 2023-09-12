/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {NoCommandScriptExecution} from './execution/no-command.js';
import {StandardScriptExecution} from './execution/standard.js';
import {ServiceScriptExecution} from './execution/service.js';
import {
  ScriptReference,
  ScriptReferenceString,
  scriptReferenceToString,
} from './config.js';
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
import type {ExecutionRequestedReason, Failure} from './event.js';
import type {Fingerprint} from './fingerprint.js';

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
  fn: typeof executorConstructorHook,
) {
  executorConstructorHook = fn;
}

/**
 * Executes a script that has been analyzed and validated by the Analyzer.
 */
export class Executor {
  readonly #rootConfig: ScriptConfig;
  readonly #executions = new Map<ScriptReferenceString, Execution>();
  readonly #persistentServices: ServiceMap = new Map();
  readonly #ephemeralServices: ServiceScriptExecution[] = [];
  #previousIterationServices: ServiceMap | undefined;
  readonly #logger: Logger;
  readonly #workerPool: WorkerPool;
  readonly #cache?: Cache;
  readonly #isWatchMode: boolean;
  readonly #previousWatchIterationFailures:
    | Map<ScriptReferenceString, Fingerprint>
    | undefined;

  /** Resolves when the first failure occurs in any script. */
  readonly #failureOccured = new Deferred<void>();
  /** Resolves when we decide that new scripts should not be started. */
  readonly #stopStartingNewScripts = new Deferred<void>();
  /** Resolves when we decide that running scripts should be killed. */
  readonly #killRunningScripts = new Deferred<void>();
  /** Resolves when we decide that services should be stopped. */
  readonly #stopServices = new Deferred<void>();

  constructor(
    rootConfig: ScriptConfig,
    logger: Logger,
    workerPool: WorkerPool,
    cache: Cache | undefined,
    failureMode: FailureMode,
    previousIterationServices: ServiceMap | undefined,
    isWatchMode: boolean,
    previousWatchIterationFailures?: Map<ScriptReferenceString, Fingerprint>,
  ) {
    executorConstructorHook?.(this);
    this.#rootConfig = rootConfig;
    this.#logger = logger;
    this.#workerPool = workerPool;
    this.#cache = cache;
    this.#previousIterationServices = previousIterationServices;
    this.#isWatchMode = isWatchMode;
    this.#previousWatchIterationFailures = previousWatchIterationFailures;

    // If a failure occurs, then whether we stop starting new scripts or kill
    // running ones depends on the failure mode setting.
    void this.#failureOccured.promise.then(() => {
      switch (failureMode) {
        case 'continue': {
          if (!this.#isWatchMode) {
            this.#stopServices.resolve();
          }
          break;
        }
        case 'no-new': {
          this.#stopStartingNewScripts.resolve();
          if (!this.#isWatchMode) {
            this.#stopServices.resolve();
          }
          break;
        }
        case 'kill': {
          this.#stopStartingNewScripts.resolve();
          this.#killRunningScripts.resolve();
          this.#stopServices.resolve();
          break;
        }
        default: {
          const never: never = failureMode;
          throw new Error(
            `Internal error: unexpected failure mode: ${String(never)}`,
          );
        }
      }
    });
  }

  /**
   * If this entire execution is aborted because e.g. the user sent a SIGINT to
   * the Wireit process, then dont start new scripts, and kill running ones.
   */
  abort() {
    this.#stopStartingNewScripts.resolve();
    this.#killRunningScripts.resolve();
    this.#stopServices.resolve();
    if (this.#previousIterationServices !== undefined) {
      for (const service of this.#previousIterationServices.values()) {
        void service.abort({name: 'the run was aborted'});
      }
    }
  }

  /**
   * Execute the root script.
   */
  async execute(): Promise<{
    persistentServices: ServiceMap;
    errors: Failure[];
  }> {
    if (
      this.#previousIterationServices !== undefined &&
      this.#previousIterationServices.size > 0
    ) {
      // If any services were removed from the graph entirely, or used to be
      // persistent but are no longer, then stop them now.
      const currentPersistentServices = new Set<ScriptReferenceString>();
      for (const script of findAllScripts(this.#rootConfig)) {
        if (script.service && script.isPersistent) {
          currentPersistentServices.add(scriptReferenceToString(script));
        }
      }
      const abortPromises = [];
      for (const [key, service] of this.#previousIterationServices) {
        if (!currentPersistentServices.has(key)) {
          abortPromises.push(
            service.abort({
              name: 'the depgraph changed, service is no longer needed',
            }),
          );
          this.#previousIterationServices.delete(key);
        }
      }
      await Promise.all(abortPromises);
    }

    const errors: Failure[] = [];
    const rootExecutionResult = await this.getExecution(this.#rootConfig, {
      path: [],
    }).execute();
    if (!rootExecutionResult.ok) {
      errors.push(...rootExecutionResult.error);
    }
    // Wait for all persistent services to start.
    for (const service of this.#persistentServices.values()) {
      // Persistent services start automatically, so calling start() here should
      // be a no-op, but it lets us get the started promise.
      const result = await service.start();
      if (!result.ok) {
        errors.push(result.error);
      }
    }
    // Wait for all ephemeral services to have terminated (either started and
    // stopped, or never needed to start).
    const ephemeralServiceResults = await Promise.all(
      this.#ephemeralServices.map((service) => service.terminated),
    );
    for (const result of ephemeralServiceResults) {
      if (!result.ok) {
        errors.push(result.error);
      }
    }
    // All previous services are either now adopted or stopped. Remove the
    // reference to this map to allow for garbage collection, otherwise in watch
    // mode we'll have a chain of references all the way back through every
    // iteration.
    this.#previousIterationServices = undefined;
    return {
      persistentServices: this.#persistentServices,
      errors,
    };
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

  /**
   * Get the execution instance for a script config, creating one if it doesn't
   * already exist.
   */
  getExecution<T extends ScriptConfig>(
    config: T,
    executionRequestedReason: ExecutionRequestedReason,
  ): ConfigToExecution<T> {
    const key = scriptReferenceToString(config);
    let execution = this.#executions.get(key);
    if (execution === undefined) {
      if (config.command === undefined) {
        execution = new NoCommandScriptExecution(
          config,
          this,
          this.#logger,
          executionRequestedReason,
        );
      } else if (config.service !== undefined) {
        execution = new ServiceScriptExecution(
          config,
          this,
          this.#logger,
          this.#stopServices.promise,
          this.#previousIterationServices?.get(key),
          this.#isWatchMode,
          executionRequestedReason,
        );
        if (config.isPersistent) {
          this.#persistentServices.set(key, execution);
        } else {
          this.#ephemeralServices.push(execution);
        }
      } else {
        execution = new StandardScriptExecution(
          config,
          this,
          this.#workerPool,
          this.#cache,
          this.#logger,
          executionRequestedReason,
        );
      }
      this.#executions.set(key, execution);
    }
    // Cast needed because our Map type doesn't know about the config ->
    // execution type guarantees. We could make a smarter Map type, but not
    // really worth it here.
    return execution as ConfigToExecution<T>;
  }

  /**
   * If we're in watch mode, check whether in the previous watch iteration the
   * given script failed with the given fingerprint.
   */
  failedInPreviousWatchIteration(
    script: ScriptReference,
    fingerprint: Fingerprint,
  ): boolean {
    if (this.#previousWatchIterationFailures === undefined) {
      return false;
    }
    const previous = this.#previousWatchIterationFailures.get(
      scriptReferenceToString(script),
    );
    if (previous === undefined) {
      return false;
    }
    return previous.equal(fingerprint);
  }

  /**
   * If we're in watch mode, record that a script failed for the purpose of
   * preventing it from running unless its fingerprint changes in the next watch
   * iteration.
   */
  registerWatchIterationFailure(
    script: ScriptReference,
    fingerprint: Fingerprint,
  ): void {
    this.#previousWatchIterationFailures?.set(
      scriptReferenceToString(script),
      fingerprint,
    );
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
