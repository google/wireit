/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {shuffle} from '../util/shuffle.js';
import {Fingerprint} from '../fingerprint.js';
import {Deferred} from '../util/deferred.js';

import type {Result} from '../error.js';
import type {Executor} from '../executor.js';
import type {Dependency, ScriptConfig} from '../config.js';
import type {Logger} from '../logging/logger.js';
import type {Failure} from '../event.js';

export type ExecutionResult = Result<Fingerprint, Failure[]>;

/**
 * What to do when a script failure occurs:
 *
 * - `no-new`: Allow running scripts to finish, but don't start new ones.
 * - `continue`: Allow running scripts to finish, and start new ones unless a
 *   dependency failed.
 * - `kill`: Immediately kill running scripts, and don't start new ones.
 */
export type FailureMode = 'no-new' | 'continue' | 'kill';

let executionConstructorHook:
  | ((executor: BaseExecution<ScriptConfig>) => void)
  | undefined;

/**
 * For GC testing only. A function that is called whenever an Execution is
 * constructed.
 */
export function registerExecutionConstructorHook(
  fn: typeof executionConstructorHook,
) {
  executionConstructorHook = fn;
}

/**
 * A single execution of a specific script.
 */
export abstract class BaseExecution<T extends ScriptConfig> {
  protected readonly _config: T;
  protected readonly _executor: Executor;
  protected readonly _logger: Logger;
  private _fingerprint?: Promise<ExecutionResult>;

  constructor(config: T, executor: Executor, logger: Logger) {
    executionConstructorHook?.(this);
    this._config = config;
    this._executor = executor;
    this._logger = logger;
  }

  /**
   * Execute this script and return its fingerprint. Cached, so safe to call
   * multiple times.
   */
  execute(): Promise<ExecutionResult> {
    return (this._fingerprint ??= this._execute());
  }

  protected abstract _execute(): Promise<ExecutionResult>;

  /**
   * Execute all of this script's dependencies.
   */
  protected async _executeDependencies(): Promise<
    Result<Array<[Dependency, Fingerprint]>, Failure[]>
  > {
    // Randomize the order we execute dependencies to make it less likely for a
    // user to inadvertently depend on any specific order, which could indicate
    // a missing edge in the dependency graph.
    shuffle(this._config.dependencies);

    const dependencyResults = await Promise.all(
      this._config.dependencies.map((dependency) => {
        return this._executor.getExecution(dependency.config).execute();
      }),
    );
    const results: Array<[Dependency, Fingerprint]> = [];
    const errors = new Set<Failure>();
    for (let i = 0; i < dependencyResults.length; i++) {
      const result = dependencyResults[i];
      if (!result.ok) {
        for (const error of result.error) {
          errors.add(error);
        }
      } else {
        results.push([this._config.dependencies[i], result.value]);
      }
    }
    if (errors.size > 0) {
      return {ok: false, error: [...errors]};
    }
    return {ok: true, value: results};
  }
}

/**
 * A single execution of a specific script which has a command.
 */
export abstract class BaseExecutionWithCommand<
  T extends ScriptConfig & {
    command: Exclude<ScriptConfig['command'], undefined>;
  },
> extends BaseExecution<T> {
  protected readonly _servicesNotNeeded = new Deferred<void>();

  /**
   * Resolves when this script no longer needs any of its service dependencies
   * to be running. This could happen because it finished, failed, or never
   * needed to run at all.
   */
  readonly servicesNotNeeded = this._servicesNotNeeded.promise;

  /**
   * Resolves when any of the services this script depends on have terminated
   * (see {@link ServiceScriptExecution.terminated} for exact definiton).
   */
  protected readonly _anyServiceTerminated = Promise.race(
    this._config.services.map(
      (service) => this._executor.getExecution(service).terminated,
    ),
  );

  /**
   * Ensure that all of the services this script depends on are running.
   */
  protected async _startServices(): Promise<Result<void, Failure[]>> {
    if (this._config.services.length > 0) {
      const results = await Promise.all(
        this._config.services.map((service) =>
          this._executor.getExecution(service).start(),
        ),
      );
      const errors: Failure[] = [];
      for (const result of results) {
        if (!result.ok) {
          errors.push(result.error);
        }
      }
      if (errors.length > 0) {
        return {ok: false, error: errors};
      }
    }
    return {ok: true, value: undefined};
  }
}
