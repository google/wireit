/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseExecutionWithCommand} from './base.js';
import {Fingerprint} from '../fingerprint.js';
import {Deferred} from '../util/deferred.js';
import {ScriptChildProcess} from '../script-child-process.js';

import type {ExecutionResult} from './base.js';
import type {ScriptReference, ServiceScriptConfig} from '../config.js';
import type {Executor} from '../executor.js';
import type {Logger} from '../logging/logger.js';
import type {Failure} from '../event.js';
import type {Result} from '../error.js';

type ServiceState =
  | {id: 'initial'}
  | {
      id: 'executingDeps';
      fingerprint: Deferred<ExecutionResult>;
    }
  | {
      id: 'fingerprinting';
      fingerprint: Deferred<ExecutionResult>;
    }
  | {id: 'unstarted'}
  | {
      id: 'depsStarting';
      started: Deferred<Result<void, Failure[]>>;
    }
  | {
      id: 'starting';
      child: ScriptChildProcess;
      started: Deferred<Result<void, Failure[]>>;
    }
  | {
      id: 'started';
      child: ScriptChildProcess;
    }
  | {id: 'stopping'}
  | {id: 'stopped'}
  | {
      id: 'failed';
      failure: Failure;
    };

function unknownState(state: never) {
  return new Error(
    `Unknown service state ${String((state as ServiceState).id)}`
  );
}

function unexpectedState(state: ServiceState) {
  return new Error(`Unexpected service state ${state.id}`);
}

/**
 * Execution for a {@link ServiceScriptConfig}.
 *
 * Note that this class represents a service _bound to one particular execution_
 * of the script graph. In non-watch mode (`npm run ...`), there will be one
 * instance of this class per service. In watch mode (`npm run --watch ...`),
 * there will be one instance of this class per service _per watch iteration_,
 * and the underlying child process will be transfered between instances of this
 * class whenever possible to avoid restarts.
 *
 * ```
 *                    ┌─────────┐
 *     ╭─◄─ abort ────┤ INITIAL │
 *     │              └────┬────┘
 *     │                   │
 *     ▼                execute
 *     │                   │
 *     │           ┌───────▼────────┐
 *     ├─◄─ abort ─┤ EXECUTING_DEPS ├──── depExecErr ────►───╮
 *     │           └───────┬────────┘                        │
 *     │                   │                                 │
 *     ▼              depsExecuted                           │
 *     │                   │                                 │
 *     │           ┌───────▼────────┐                        │
 *     ├─◄─ abort ─┤ FINGERPRINTING │                        │
 *     │           └───────┬────────┘                        │
 *     │                   │                                 │
 *     ▼             fingerprinted                           │
 *     │                   │                                 │
 *     │             ┌─────▼─────┐                           │
 *     ├─◄─ abort ───┤ UNSTARTED │                           │
 *     │             └─────┬─────┘                           ▼
 *     │                   │                                 │
 *     │                 start  ╭─╮                          │
 *     │                   │    │ start                      │
 *     │           ┌───────▼────▼─┴┐                         │
 *     ├─◄─ abort ─┤ DEPS_STARTING ├───── depStartErr ───►───┤
 *     │           └───────┬───────┘                         │
 *     │                   │                                 │
 *     │              depsStarted                            │
 *     │                   │  ╭─╮                            │
 *     │                   │  │ start                        │
 *     │              ┌────▼──▼─┴┐                           │
 *     │    ╭◄─ abort ┤ STARTING ├──── startErr ──────►──────┤
 *     │    │         └────┬────┬┘                           │
 *     ▼    │              │    │                            │
 *     │    │              │    ▼                            │
 *     │    │              │    ╰─── depServiceExit ──►──╮   │
 *     │    │           started                          │   │
 *     │    ▼              │ ╭─╮                         ▼   │
 *     │    │              │ │ start                     │   │
 *     │    │         ┌────▼─▼─┴┐                        │   │
 *     │    ├◄─ abort ┤ STARTED ├── exit ─────────────►──│───┤
 *     │    │         └────┬─┬─┬┘                        │   │
 *     │    │              │ │ ╰─── detach ──╮           │   │
 *     │    │              │ ▼               │           │   │
 *     │    │              │ ╰───── depServiceExit ───►──┤   │
 *     │    │              │                 │           │   │
 *     │    │        allConsumersDone        │           │   │
 *     │    ▼    (unless directly invoked)   │           │   │
 *     │    │              │                 ▼           ▼   ▼
 *     ▼    │              │  ╭─╮            │           │   │
 *     │    │              │  │ start        │           │   │
 *     │    │         ┌────▼──▼─┴┐           │           │   │
 *     │    ╰─────────► STOPPING ◄─────────────◄─────────╯   │
 *     │              └┬─▲─┬─────┘           │               │
 *     │           abort │ │                 │               │
 *     │               ╰─╯ │                 │               │
 *     │                  exit               │               │
 *     │                   │ ╭─╮             │               │ ╭─╮
 *     │                   │ │ start         │               │ │ start
 *     │              ┌────▼─▼─┴┐       ┌────▼─────┐     ┌───▼─▼─┴┐
 *     ╰──────────────► STOPPED │       │ DETACHED │     │ FAILED │
 *                    └┬─▲──────┘       └┬─▲───────┘     └┬─▲─────┘
 *                 abort │           *all* │          abort │
 *                     ╰─╯               ╰─╯              ╰─╯
 * ```
 */
export class ServiceScriptExecution extends BaseExecutionWithCommand<ServiceScriptConfig> {
  private _state: ServiceState = {id: 'initial'};
  private readonly _terminated = new Deferred<Result<void, Failure>>();

  /**
   * Resolves as "ok" when this script decides it is no longer needed, and
   * either has begun shutting down, or never needed to start in the first
   * place.
   *
   * Resolves with an error if this service exited unexpectedly, or if any of
   * its own service dependencies exited unexpectedly.
   */
  readonly terminated = this._terminated.promise;

  constructor(
    config: ServiceScriptConfig,
    executor: Executor,
    logger: Logger,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _abort: Promise<void>
  ) {
    super(config, executor, logger);
  }

  /**
   * Note `execute` is a bit of a misnomer here, because we don't actually
   * execute the command at this stage in the case of services.
   */
  protected override _execute(): Promise<ExecutionResult> {
    switch (this._state.id) {
      case 'initial': {
        this._state = {
          id: 'executingDeps',
          fingerprint: new Deferred(),
        };
        void this._executeDependencies().then((result) => {
          if (result.ok) {
            this._onDepsExecuted(result.value);
          } else {
            this._onDepExecErr(result);
          }
        });
        return this._state.fingerprint.promise;
      }
      case 'executingDeps':
      case 'fingerprinting':
      case 'unstarted':
      case 'depsStarting':
      case 'starting':
      case 'started':
      case 'stopping':
      case 'stopped':
      case 'failed': {
        throw unexpectedState(this._state);
      }
      default: {
        throw unknownState(this._state);
      }
    }
  }

  private _onDepsExecuted(
    depFingerprints: Array<[ScriptReference, Fingerprint]>
  ): void {
    switch (this._state.id) {
      case 'executingDeps': {
        this._state = {
          id: 'fingerprinting',
          fingerprint: this._state.fingerprint,
        };
        void Fingerprint.compute(this._config, depFingerprints).then(
          (result) => {
            this._onFingerprinted(result);
          }
        );
        return;
      }
      case 'failed': {
        return;
      }
      case 'initial':
      case 'fingerprinting':
      case 'unstarted':
      case 'depsStarting':
      case 'starting':
      case 'started':
      case 'stopping':
      case 'stopped': {
        throw unexpectedState(this._state);
      }
      default: {
        throw unknownState(this._state);
      }
    }
  }

  private _onDepExecErr(result: ExecutionResult & {ok: false}) {
    switch (this._state.id) {
      case 'executingDeps': {
        this._state.fingerprint.resolve(result);
        return;
      }
      case 'failed': {
        return;
      }
      case 'initial':
      case 'fingerprinting':
      case 'unstarted':
      case 'depsStarting':
      case 'starting':
      case 'started':
      case 'stopping':
      case 'stopped': {
        throw unexpectedState(this._state);
      }
      default: {
        throw unknownState(this._state);
      }
    }
  }

  private _onFingerprinted(fingerprint: Fingerprint) {
    switch (this._state.id) {
      case 'fingerprinting': {
        this._state.fingerprint.resolve({ok: true, value: fingerprint});
        this._state = {id: 'unstarted'};
        return;
      }
      case 'failed': {
        return;
      }
      case 'initial':
      case 'executingDeps':
      case 'unstarted':
      case 'depsStarting':
      case 'starting':
      case 'started':
      case 'stopping':
      case 'stopped': {
        throw unexpectedState(this._state);
      }
      default: {
        throw unknownState(this._state);
      }
    }
  }

  /**
   * Start this service if it isn't already started.
   */
  start(): Promise<Result<void, Failure[]>> {
    switch (this._state.id) {
      case 'unstarted': {
        this._state = {
          id: 'depsStarting',
          started: new Deferred(),
        };
        void this._startServices().then(() => {
          this._onDepsStarted();
        });
        return this._state.started.promise;
      }
      case 'failed': {
        return Promise.resolve({ok: false, error: [this._state.failure]});
      }
      case 'initial':
      case 'executingDeps':
      case 'fingerprinting':
      case 'depsStarting':
      case 'starting':
      case 'started':
      case 'stopping':
      case 'stopped': {
        throw unexpectedState(this._state);
      }
      default: {
        throw unknownState(this._state);
      }
    }
  }

  private _onDepsStarted() {
    switch (this._state.id) {
      case 'depsStarting': {
        this._state = {
          id: 'starting',
          child: new ScriptChildProcess(this._config),
          started: this._state.started,
        };
        void this._state.child.started.then(() => {
          this._onChildStarted();
        });
        void this._state.child.completed.then(() => {
          this._onChildExited();
        });
        this._state.child.stdout.on('data', (data: string | Buffer) => {
          this._logger.log({
            script: this._config,
            type: 'output',
            stream: 'stdout',
            data,
          });
        });
        this._state.child.stderr.on('data', (data: string | Buffer) => {
          this._logger.log({
            script: this._config,
            type: 'output',
            stream: 'stderr',
            data,
          });
        });
        return;
      }
      case 'failed': {
        return;
      }
      case 'initial':
      case 'executingDeps':
      case 'fingerprinting':
      case 'unstarted':
      case 'starting':
      case 'started':
      case 'stopping':
      case 'stopped': {
        throw unexpectedState(this._state);
      }
      default: {
        throw unknownState(this._state);
      }
    }
  }

  private _onChildStarted() {
    switch (this._state.id) {
      case 'starting': {
        this._state.started.resolve({ok: true, value: undefined});
        this._logger.log({
          script: this._config,
          type: 'info',
          detail: 'service-started',
        });
        this._state = {
          id: 'started',
          child: this._state.child,
        };
        const allConsumersDone = Promise.all(
          this._config.serviceConsumers.map(
            (consumer) =>
              this._executor.getExecution(consumer).servicesNotNeeded
          )
        );
        void allConsumersDone.then(() => {
          this._allConsumersDone();
        });
        return;
      }
      case 'initial':
      case 'executingDeps':
      case 'fingerprinting':
      case 'unstarted':
      case 'depsStarting':
      case 'started':
      case 'stopping':
      case 'stopped':
      case 'failed': {
        throw unexpectedState(this._state);
      }
      default: {
        throw unknownState(this._state);
      }
    }
  }

  private _allConsumersDone() {
    switch (this._state.id) {
      case 'started': {
        this._state.child.kill();
        this._state = {id: 'stopping'};
        return;
      }
      case 'failed': {
        return;
      }
      case 'initial':
      case 'executingDeps':
      case 'fingerprinting':
      case 'unstarted':
      case 'depsStarting':
      case 'starting':
      case 'stopping':
      case 'stopped': {
        throw unexpectedState(this._state);
      }
      default: {
        throw unknownState(this._state);
      }
    }
  }

  private _onChildExited() {
    switch (this._state.id) {
      case 'stopping': {
        this._state = {
          id: 'stopped',
        };
        this._terminated.resolve({ok: true, value: undefined});
        this._servicesNotNeeded.resolve();
        this._logger.log({
          script: this._config,
          type: 'info',
          detail: 'service-stopped',
        });
        return;
      }
      case 'started': {
        this._fail({
          script: this._config,
          type: 'failure',
          reason: 'service-exited-unexpectedly',
        });
        return;
      }
      case 'failed': {
        return;
      }
      case 'initial':
      case 'executingDeps':
      case 'fingerprinting':
      case 'unstarted':
      case 'depsStarting':
      case 'starting':
      case 'stopped': {
        throw unexpectedState(this._state);
      }
      default: {
        throw unknownState(this._state);
      }
    }
  }

  private _fail(failure: Failure) {
    this._state = {
      id: 'failed',
      failure,
    };
    this._terminated.resolve({ok: false, error: failure});
    this._servicesNotNeeded.resolve();
    this._logger.log(failure);
  }
}
