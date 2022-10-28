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
  | {
      id: 'initial';
      entireExecutionAborted: Promise<void>;
    }
  | {
      id: 'executingDeps';
      fingerprint: Deferred<ExecutionResult>;
    }
  | {
      id: 'fingerprinting';
      fingerprint: Deferred<ExecutionResult>;
    }
  | {
      id: 'unstarted';
      fingerprint: Fingerprint;
    }
  | {
      id: 'depsStarting';
      started: Deferred<Result<void, Failure[]>>;
      fingerprint: Fingerprint;
    }
  | {
      id: 'starting';
      child: ScriptChildProcess;
      started: Deferred<Result<void, Failure[]>>;
      fingerprint: Fingerprint;
    }
  | {
      id: 'started';
      child: ScriptChildProcess;
      fingerprint: Fingerprint;
    }
  | {id: 'stopping'}
  | {id: 'stopped'}
  | {
      id: 'failing';
      failure: Failure;
    }
  | {
      id: 'failed';
      failure: Failure;
    }
  | {id: 'detached'};

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
 *     │             fingerprinted                           ▼
 *     │                   │                                 │
 *     │        ╔══════════▼════════════╗                    │
 *     ▼        ║ adoptee has different ╟─ yes ─╮            │
 *     │        ║     fingerprint?      ║       │            │
 *     │        ╚══════════╤════════════╝       │            │
 *     │                   │                    ▼            │
 *     │                   no                   │            │
 *     │                   │                    │            │
 *     │                   │          ┌─────────▼────────┐   │
 *     ├─◄─ abort ─────────│─────◄────┤ STOPPING_ADOPTEE │   │
 *     │                   │          └─────────┬────────┘   │
 *     │                   │                    │            │
 *     │                   ▼              adopteeStopped     │
 *     │                   │                    │            │
 *     │                   ├─────◄──────────────╯            │
 *     │                   │                                 │
 *     ▼        ╔══════════▼═══════════╗                     │
 *     │        ║ is directly invoked? ╟── yes ──╮           │
 *     │        ╚══════════╤═══════════╝         │           │
 *     │                   │                     │           │
 *     │                   no                    │           │
 *     │                   │                     │           │
 *     │             ┌─────▼─────┐               │           │
 *     ├─◄─ abort ───┤ UNSTARTED │               ▼           │
 *     │             └─────┬─────┘               │           │
 *     │                   │                     │           │
 *     │                 start                   │           │
 *     │                   │                     │           │
 *     │                   │  ╭─────────◄────────╯           │
 *     │                   │  │                              │
 *     │                   │  │ ╭─╮                          │
 *     │                   │  │ │start                       │
 *     │           ┌───────▼──▼─▼─┴┐                         │
 *     ├─◄─ abort ─┤ DEPS_STARTING ├───── depStartErr ───►───┤
 *     │           └───────┬───────┘                         │
 *     │                   │                                 │
 *     │              depsStarted                            ▼
 *     │                   │  ╭─╮                            │
 *     │                   │  │ start                        │
 *     │              ┌────▼──▼─┴┐                           │
 *     │    ╭◄─ abort ┤ STARTING ├──── startErr ──────►──────┤
 *     │    │         └────┬────┬┘                           │
 *     │    │              │    │                            │
 *     │    │              │    ╰─ depServiceExit ─►─╮       │
 *     ▼    │              │                         │       │
 *     │    │              │                         │       │
 *     │    ▼              │                         ▼       ▼
 *     │    │           started                      │       │
 *     │    │              │ ╭─╮                     │       │
 *     │    │              │ │ start                 │       │
 *     │    │         ┌────▼─▼─┴┐                    │       │
 *     │    ├◄─ abort ┤ STARTED ├── exit ────────────────────┤
 *     │    │         └──────┬─┬┘                    │       │
 *     │    │                │ │                     │       │
 *     │    │                │ ╰── depServiceExit ─►─┤       │
 *     │    │                │                       │       │
 *     │    │                ╰───── detach ──╮       │       │
 *     │    │                                │       │       │
 *     ▼    │                                ▼       │       ▼
 *     │    │         ┌──────────┐           │  ┌────▼────┐  │
 *     │    ╰─────────► STOPPING │           │  │ FAILING │  │
 *     │              └┬─▲─┬─────┘           │  └────┬────┘  │
 *     │           abort │ │                 │       │       │
 *     │               ╰─╯ │                 │      exit     │
 *     │                  exit               │       │       │
 *     │                   │ ╭─╮             │       ╰─────╮ │ ╭─╮
 *     │                   │ │ start         │             │ │ │ start
 *     │              ┌────▼─▼─┴┐       ┌────▼─────┐     ┌─▼─▼─▼─┴┐
 *     ╰──────────────► STOPPED │       │ DETACHED │     │ FAILED │
 *                    └┬─▲──────┘       └┬─▲───────┘     └┬─▲─────┘
 *                 abort │           *all* │          abort │
 *                     ╰─╯               ╰─╯              ╰─╯
 * ```
 */
export class ServiceScriptExecution extends BaseExecutionWithCommand<ServiceScriptConfig> {
  private _state: ServiceState;
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
    entireExecutionAborted: Promise<void>
  ) {
    super(config, executor, logger);
    this._state = {
      id: 'initial',
      entireExecutionAborted,
    };
  }

  /**
   * Return the fingerprint of this service. If the fingerprint is not yet
   * computed, or if the service is stopped/failed/detached, returns undefined.
   */
  get fingerprint(): Fingerprint | undefined {
    switch (this._state.id) {
      case 'unstarted':
      case 'depsStarting':
      case 'starting':
      case 'started': {
        return this._state.fingerprint;
      }
      case 'initial':
      case 'executingDeps':
      case 'fingerprinting':
      case 'stopping':
      case 'stopped':
      case 'failed':
      case 'failing':
      case 'detached': {
        return undefined;
      }
      default: {
        throw unknownState(this._state);
      }
    }
  }

  detach(): ScriptChildProcess | undefined {
    switch (this._state.id) {
      case 'started': {
        const child = this._state.child;
        this._state = {id: 'detached'};
        // TODO(aomarks) There are a few promises that could still resolve even
        // when we are detached, such as "abort" and "child exited". While we do
        // correctly handle those events (by doing nothing in the handlers), the
        // fact that the promises remain unresolved will prevent GC of old
        // executions in watch mode. Those promises should probably be
        // Promise.race'd to prevent that.
        child.stdout.removeAllListeners();
        child.stderr.removeAllListeners();
        return child;
      }
      case 'stopping':
      case 'stopped':
      case 'failed':
      case 'failing': {
        return undefined;
      }
      case 'unstarted':
      case 'depsStarting':
      case 'starting':
      case 'initial':
      case 'executingDeps':
      case 'fingerprinting':
      case 'detached': {
        throw unexpectedState(this._state);
      }
      default: {
        throw unknownState(this._state);
      }
    }
  }

  /**
   * Note `execute` is a bit of a misnomer here, because we don't actually
   * execute the command at this stage in the case of services.
   */
  protected override _execute(): Promise<ExecutionResult> {
    switch (this._state.id) {
      case 'initial': {
        const allConsumersDone = Promise.all(
          this._config.serviceConsumers.map(
            (consumer) =>
              this._executor.getExecution(consumer).servicesNotNeeded
          )
        );
        const abort = this._config.isDirectlyInvoked
          ? Promise.all([this._state.entireExecutionAborted, allConsumersDone])
          : allConsumersDone;
        void abort.then(() => {
          this._onAbort();
        });

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
      case 'failed':
      case 'failing':
      case 'detached': {
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
      case 'stopped':
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
      case 'failing':
      case 'detached': {
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
      case 'stopped':
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
      case 'failing':
      case 'detached': {
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
        this._state = {
          id: 'unstarted',
          fingerprint,
        };
        if (this._config.isDirectlyInvoked) {
          void this.start();
        }
        return;
      }
      case 'failed':
      case 'stopped': {
        return;
      }
      case 'initial':
      case 'executingDeps':
      case 'unstarted':
      case 'depsStarting':
      case 'starting':
      case 'started':
      case 'stopping':
      case 'failing':
      case 'detached': {
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
          fingerprint: this._state.fingerprint,
        };
        void this._startServices().then(() => {
          this._onDepsStarted();
        });
        void this._anyServiceTerminated.then(() => {
          this._onDepServiceExit();
        });
        return this._state.started.promise;
      }
      case 'failing':
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
      case 'stopped':
      case 'detached': {
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
          fingerprint: this._state.fingerprint,
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
      case 'stopped':
      case 'failing':
      case 'detached': {
        throw unexpectedState(this._state);
      }
      default: {
        throw unknownState(this._state);
      }
    }
  }

  private _onDepServiceExit() {
    switch (this._state.id) {
      case 'started': {
        this._state.child.kill();
        this._state = {
          id: 'failing',
          failure: {
            type: 'failure',
            script: this._config,
            // TODO(aomarks) Wrong
            reason: 'service-exited-unexpectedly',
          },
        };
        return;
      }
      case 'stopped':
      case 'detached': {
        return;
      }
      case 'depsStarting':
      case 'initial':
      case 'executingDeps':
      case 'fingerprinting':
      case 'unstarted':
      case 'starting':
      case 'stopping':
      case 'failing':
      case 'failed': {
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
          fingerprint: this._state.fingerprint,
        };
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
      case 'failing':
      case 'failed':
      case 'detached': {
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
      case 'failing': {
        this._fail(this._state.failure);
        return;
      }
      case 'failed':
      case 'detached': {
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

  private _onAbort() {
    switch (this._state.id) {
      case 'started': {
        this._state.child.kill();
        this._state = {id: 'stopping'};
        return;
      }
      case 'starting': {
        this._state = {id: 'stopping'};
        return;
      }
      case 'initial':
      case 'executingDeps':
      case 'fingerprinting':
      case 'unstarted':
      case 'depsStarting': {
        this._state = {id: 'stopped'};
        return;
      }
      case 'stopping':
      case 'stopped':
      case 'failing':
      case 'failed':
      case 'detached': {
        return;
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
