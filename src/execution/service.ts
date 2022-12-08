/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseExecutionWithCommand} from './base.js';
import {Fingerprint} from '../fingerprint.js';
import {Deferred} from '../util/deferred.js';
import {ScriptChildProcess} from '../script-child-process.js';
import {LineMonitor} from '../util/line-monitor.js';

import type {ExecutionResult} from './base.js';
import type {Dependency, ServiceScriptConfig} from '../config.js';
import type {Executor} from '../executor.js';
import type {Logger} from '../logging/logger.js';
import type {Failure} from '../event.js';
import type {Result} from '../error.js';

type ServiceState =
  | {
      id: 'initial';
      entireExecutionAborted: Promise<void>;
      adoptee: ServiceScriptExecution | undefined;
    }
  | {
      id: 'executingDeps';
      deferredFingerprint: Deferred<ExecutionResult>;
      adoptee: ServiceScriptExecution | undefined;
    }
  | {
      id: 'fingerprinting';
      deferredFingerprint: Deferred<ExecutionResult>;
      adoptee: ServiceScriptExecution | undefined;
    }
  | {
      id: 'stoppingAdoptee';
      fingerprint: Fingerprint;
      deferredFingerprint: Deferred<ExecutionResult>;
    }
  | {
      id: 'unstarted';
      fingerprint: Fingerprint;
      adoptee: ServiceScriptExecution | undefined;
    }
  | {
      id: 'depsStarting';
      started: Deferred<Result<void, Failure>>;
      fingerprint: Fingerprint;
      adoptee: ServiceScriptExecution | undefined;
    }
  | {
      id: 'starting';
      child: ScriptChildProcess;
      started: Deferred<Result<void, Failure>>;
      fingerprint: Fingerprint;
      readyMonitor: LineMonitor | undefined;
    }
  | {
      id: 'readying';
      child: ScriptChildProcess;
      started: Deferred<Result<void, Failure>>;
      fingerprint: Fingerprint;
      readyMonitor: LineMonitor;
    }
  | {
      id: 'started';
      child: ScriptChildProcess;
      fingerprint: Fingerprint;
    }
  | {
      id: 'stopping';
      child: ScriptChildProcess;
      fingerprint: Fingerprint;
    }
  | {id: 'stopped'}
  | {
      id: 'failing';
      child: ScriptChildProcess;
      failure: Failure;
      fingerprint: Fingerprint;
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
 *     ├─◄─ abort ─┤ EXECUTING_DEPS ├──── depExecErr ────►────╮
 *     │           └───────┬────────┘                         │
 *     │                   │                                  │
 *     ▼              depsExecuted                            │
 *     │                   │                                  │
 *     │           ┌───────▼────────┐                         │
 *     ├─◄─ abort ─┤ FINGERPRINTING │                         │
 *     │           └───────┬────────┘                         │
 *     │                   │                                  │
 *     │             fingerprinted                            ▼
 *     │                   │                                  │
 *     │        ╔══════════▼════════════╗                     │
 *     ▼        ║ adoptee has different ╟─ yes ─╮             │
 *     │        ║     fingerprint?      ║       │             │
 *     │        ╚══════════╤════════════╝       │             │
 *     │                   │                    ▼             │
 *     │                   no                   │             │
 *     │                   │                    │             │
 *     │                   │          ┌─────────▼────────┐    │
 *     ├─◄─ abort ─────────│─────◄────┤ STOPPING_ADOPTEE │    │
 *     │                   │          └─────────┬────────┘    │
 *     │                   │                    │             │
 *     │                   ▼              adopteeStopped      │
 *     │                   │                    │             │
 *     │                   ├─────◄──────────────╯             │
 *     │                   │                                  │
 *     ▼           ╔═══════▼════════╗                         │
 *     │           ║ is persistent? ╟───── yes ──╮            │
 *     │           ╚═══════╤════════╝            │            │
 *     │                   │                     │            │
 *     │                   no                    │            │
 *     │                   │                     │            │
 *     │             ┌─────▼─────┐               │            │
 *     ├─◄─ abort ───┤ UNSTARTED │               ▼            ▼
 *     │             └─────┬─────┘               │            │
 *     │                   │                     │            │
 *     │                 start                   │            │
 *     │                   │                     │            │
 *     │                   │  ╭─────────◄────────╯            │
 *     │                   │  │                               │
 *     │                   │  │ ╭─╮                           │
 *     │                   │  │ │start                        │
 *     │           ┌───────▼──▼─▼─┴┐                          │
 *     ├─◄─ abort ─┤ DEPS_STARTING ├───── depStartErr ───►────┤
 *     │           └───────┬───────┘                          │
 *     │                   │                                  │
 *     │              depsStarted                             │
 *     │                   │                                  │
 *     │                   │   ┌────────────────┐       ╔═════▼════════╗
 *     │    ╭◄─ abort ─────│─◄─┤ STARTED_BROKEN ◄─ yes ─╢ has adoptee? ║
 *     │    │              │   └───────┬────────┘       ╚═════╤════════╝
 *     │    │              │           │                      │
 *     │    │              │         detach                   no
 *     │    │              │           │                      │
 *     │    │              │           ╰────────►────────╮    │
 *     ▼    │       ╔══════▼═══════╗                     │    │
 *     │    ▼       ║ has adoptee? ╟───── yes ───────╮   │    │
 *     │    │       ╚══════╤═══════╝                 │   │    │
 *     │    │              │                         │   │    │
 *     │    │              no                        │   │    │
 *     │    │              │  ╭─╮                    ▼   ▼    ▼
 *     │    │              │  │ start                │   │    │
 *     │    │         ┌────▼──▼─┴┐                   │   │    │
 *     │    ├◄─ abort ┤ STARTING ├──── startErr ──────►───────┤
 *     │    │         └────┬────┬┘                   │   │    │
 *     │    │              │    │                    │   │    │
 *     │    │              │    ╰─ depServiceExit ───────────►──────────╮
 *     │    │              │     (unless watch mode) │   │    │         │
 *     │    │              │                         │   │    │         │
 *     │    │            started                     │   │    │         │
 *     │    │              │                         │   │    │         │
 *     │    │   ╔══════════▼═══════════╗             │   │    │         │
 *     ▼    │   ║ has ready condition? ╟──╮          │   │    │         │
 *     │    │   ╚══════════╤═══════════╝  │          │   │    │         │
 *     │    │              │              │          │   │    │         │
 *     │    │              no            yes         │   │    │         │
 *     │    │              │              │          │   │    │         │
 *     │    ▼              ▼         ┌────▼─────┐    ▼   ▼    ▼         ▼
 *     │    │              │         │ READYING │    │   │    │         │
 *     │    │              │         └────┬───┬─┘    │   │    │         │
 *     │    │              │              │   │      │   │    │         │
 *     │    │              │            ready ╰── depServiceExit ───►───┤
 *     │    │              │              │     (unless watch mode)     │
 *     │    │              │ ╭─────◄──────╯          │   │    │         │
 *     │    │              │ │                       │   │    │         │
 *     │    │          ╭─╮ │ │ ╭──────────◄──────────╯   │    │         │
 *     │    │      start │ │ │ │                         │    │         │
 *     │    │         ┌▼─┴─▼─▼─▼┐                        │    │         │
 *     │    ├◄─ abort ┤ STARTED ├── exit ──────────►──────────┤         │
 *     │    │         └──────┬─┬┘                        │    │         │
 *     │    │                │ │                         │    │         │
 *     │    │                │ ╰── depServiceExit ────────────►─────────┤
 *     │    │                │   (unless watch mode)     │    │         │
 *     │    ▼                │                           │    │         │
 *     │    │                ╰─── detach ──►─┬─────◄─────╯    │         │
 *     │    │                                │                │         │
 *     ▼    │                                │                │         │
 *     │    │         ┌──────────┐           │                │    ┌────▼────┐
 *     │    ╰─────────► STOPPING │           ▼                ▼    │ FAILING │
 *     │              └┬─▲─┬─────┘           │                │    └────┬────┘
 *     │           abort │ │                 │                │         │
 *     │               ╰─╯ │                 │                │        exit
 *     │                  exit               │                │         │
 *     │                   │ ╭─╮             │                │ ╭─╮     │
 *     │                   │ │ start         │                │ │ start │
 *     │              ┌────▼─▼─┴┐       ┌────▼─────┐      ┌───▼─▼─┴┐    │
 *     ╰──────────────► STOPPED │       │ DETACHED │      │ FAILED ◄────╯
 *                    └┬─▲──────┘       └┬─▲───────┘      └┬─▲─────┘
 *                 abort │           *all* │           abort │
 *                     ╰─╯               ╰─╯               ╰─╯
 * ```
 */
export class ServiceScriptExecution extends BaseExecutionWithCommand<ServiceScriptConfig> {
  private _state: ServiceState;
  private readonly _terminated = new Deferred<Result<void, Failure>>();
  private readonly _isWatchMode: boolean;

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
    entireExecutionAborted: Promise<void>,
    adoptee: ServiceScriptExecution | undefined,
    isWatchMode: boolean
  ) {
    super(config, executor, logger);
    this._isWatchMode = isWatchMode;
    this._state = {
      id: 'initial',
      entireExecutionAborted,
      adoptee,
    };
  }

  /**
   * Return the fingerprint of this service. Throws if the fingerprint is not
   * yet available. Returns undefined if the service is stopped/failed/detached.
   */
  get fingerprint(): Fingerprint | undefined {
    switch (this._state.id) {
      case 'stoppingAdoptee':
      case 'unstarted':
      case 'depsStarting':
      case 'starting':
      case 'readying':
      case 'started':
      case 'stopping':
      case 'failing': {
        return this._state.fingerprint;
      }
      case 'stopped':
      case 'failed': {
        return;
      }
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
   * Take over ownership of this service's running child process, if there is
   * one.
   */
  detach(): ScriptChildProcess | undefined {
    switch (this._state.id) {
      case 'started':
      case 'stopping':
      case 'failing': {
        const child = this._state.child;
        this._state = {id: 'detached'};
        // Note that for some reason, removing all listeners from stdout/stderr
        // without specifying the "data" event will also remove the listeners
        // directly on "child" inside the ScriptChildProceess for noticing when
        // e.g. the process has exited.
        child.stdout.removeAllListeners('data');
        child.stderr.removeAllListeners('data');
        return child;
      }
      case 'stopped':
      case 'failed': {
        return undefined;
      }
      case 'unstarted':
      case 'depsStarting':
      case 'starting':
      case 'readying':
      case 'initial':
      case 'executingDeps':
      case 'fingerprinting':
      case 'stoppingAdoptee':
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
        const abort = this._config.isPersistent
          ? Promise.all([this._state.entireExecutionAborted, allConsumersDone])
          : allConsumersDone;
        void abort.then(() => {
          void this.abort();
        });

        this._state = {
          id: 'executingDeps',
          deferredFingerprint: new Deferred(),
          adoptee: this._state.adoptee,
        };
        void this._executeDependencies().then((result) => {
          if (result.ok) {
            this._onDepsExecuted(result.value);
          } else {
            this._onDepExecErr(result);
          }
        });
        return this._state.deferredFingerprint.promise;
      }
      case 'executingDeps':
      case 'fingerprinting':
      case 'stoppingAdoptee':
      case 'unstarted':
      case 'depsStarting':
      case 'starting':
      case 'readying':
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
    depFingerprints: Array<[Dependency, Fingerprint]>
  ): void {
    switch (this._state.id) {
      case 'executingDeps': {
        this._state = {
          id: 'fingerprinting',
          deferredFingerprint: this._state.deferredFingerprint,
          adoptee: this._state.adoptee,
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
      case 'stoppingAdoptee':
      case 'unstarted':
      case 'depsStarting':
      case 'starting':
      case 'readying':
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
        this._state.deferredFingerprint.resolve(result);
        this._enterFailedState(result.error[0]);
        return;
      }
      case 'stopped':
      case 'failed': {
        return;
      }
      case 'initial':
      case 'fingerprinting':
      case 'stoppingAdoptee':
      case 'unstarted':
      case 'depsStarting':
      case 'starting':
      case 'readying':
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
        const adoptee = this._state.adoptee;
        if (
          adoptee?.fingerprint !== undefined &&
          !adoptee.fingerprint.equal(fingerprint)
        ) {
          // There is a previous running version of this service, but the
          // fingerprint changed, so we need to restart it.
          this._state = {
            id: 'stoppingAdoptee',
            fingerprint,
            deferredFingerprint: this._state.deferredFingerprint,
          };
          void adoptee.abort().then(() => {
            this._onAdopteeStopped();
          });
          return;
        }
        this._state.deferredFingerprint.resolve({
          ok: true,
          value: fingerprint,
        });
        this._state = {
          id: 'unstarted',
          fingerprint,
          adoptee,
        };
        if (this._config.isPersistent) {
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
      case 'stoppingAdoptee':
      case 'unstarted':
      case 'depsStarting':
      case 'starting':
      case 'readying':
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

  private _onAdopteeStopped() {
    switch (this._state.id) {
      case 'stoppingAdoptee': {
        this._state.deferredFingerprint.resolve({
          ok: true,
          value: this._state.fingerprint,
        });
        this._state = {
          id: 'unstarted',
          fingerprint: this._state.fingerprint,
          adoptee: undefined,
        };
        if (this._config.isPersistent) {
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
      case 'fingerprinting':
      case 'unstarted':
      case 'depsStarting':
      case 'starting':
      case 'readying':
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
  start(): Promise<Result<void, Failure>> {
    switch (this._state.id) {
      case 'unstarted': {
        const started = new Deferred<Result<void, Failure>>();
        this._state = {
          id: 'depsStarting',
          started,
          fingerprint: this._state.fingerprint,
          adoptee: this._state.adoptee,
        };
        void this._startServices().then((result) => {
          if (result.ok) {
            this._onDepsStarted();
          } else {
            this._onDepStartErr(result);
          }
        });
        void this.terminated.then((result) => {
          if (started.settled) {
            return;
          }
          // This service terminated before it started. Either a failure occured
          // or we were aborted. If we were aborted, convert to a failure,
          // because this is the start method, where ok means the service
          // started.
          started.resolve(
            !result.ok
              ? result
              : {
                  ok: false,
                  error: {
                    type: 'failure',
                    script: this._config,
                    reason: 'aborted',
                  },
                }
          );
        });
        return this._state.started.promise;
      }
      case 'depsStarting':
      case 'starting':
      case 'readying': {
        return this._state.started.promise;
      }
      case 'started': {
        return Promise.resolve({ok: true, value: undefined});
      }
      case 'failing':
      case 'failed': {
        return Promise.resolve({ok: false, error: this._state.failure});
      }
      case 'stopping':
      case 'stopped': {
        return Promise.resolve({
          ok: false,
          error: {
            type: 'failure',
            script: this._config,
            reason: 'aborted',
          },
        });
      }
      case 'initial':
      case 'executingDeps':
      case 'stoppingAdoptee':
      case 'fingerprinting':
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
        let child = this._state.adoptee?.detach();
        if (child === undefined) {
          child = new ScriptChildProcess(this._config);
          this._state = {
            id: 'starting',
            child,
            started: this._state.started,
            fingerprint: this._state.fingerprint,
            readyMonitor:
              this._config.service.readyWhen.lineMatches === undefined
                ? undefined
                : new LineMonitor(
                    child,
                    this._config.service.readyWhen.lineMatches
                  ),
          };
          void this._state.child.started.then(() => {
            this._onChildStarted();
          });
        } else {
          this._state.started.resolve({ok: true, value: undefined});
          this._state = {
            id: 'started',
            child,
            fingerprint: this._state.fingerprint,
          };
        }
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
        if (!this._isWatchMode) {
          // If we're in watch mode, we don't care about our dependency services
          // exiting because:
          //
          // 1. If we're iteration N-1 which is about to be adopted into
          //    iteration N, our dependencies will sometimes intentionally
          //    restart. This should not cause us to fail, since we'll either
          //    also restart very shortly (when cascade is true), or we'll just
          //    keep running (when cascade is false).
          //
          // 2. If we're iteration N and our dependency unexpectedly exits by
          //    itself, it's not actually helpful if we also exit. In non-watch
          //    mode it's important because we want wireit itself to exit as
          //    soon as this happens, but not so in watch mode.
          void this._anyServiceTerminated.then(() => {
            this._onDepServiceExit();
          });
        }
        return;
      }
      case 'failed': {
        return;
      }
      case 'initial':
      case 'executingDeps':
      case 'fingerprinting':
      case 'stoppingAdoptee':
      case 'unstarted':
      case 'starting':
      case 'readying':
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

  private _onDepStartErr(result: {ok: false; error: Failure[]}) {
    switch (this._state.id) {
      case 'depsStarting': {
        // TODO(aomarks) The inconsistency between using single vs multiple
        // failure result types is inconvenient. It's ok to just use the first
        // one here, but would make more sense to return all of them.
        this._terminated.resolve({ok: false, error: result.error[0]});
        return;
      }
      case 'failing':
      case 'failed':
      case 'stopping':
      case 'stopped': {
        return;
      }
      case 'initial':
      case 'executingDeps':
      case 'fingerprinting':
      case 'stoppingAdoptee':
      case 'unstarted':
      case 'starting':
      case 'readying':
      case 'started':
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
          child: this._state.child,
          fingerprint: this._state.fingerprint,
          failure: {
            type: 'failure',
            script: this._config,
            reason: 'dependency-service-exited-unexpectedly',
          },
        };
        return;
      }
      case 'starting':
      case 'readying': {
        this._state = {
          id: 'failing',
          child: this._state.child,
          fingerprint: this._state.fingerprint,
          failure: {
            type: 'failure',
            script: this._config,
            reason: 'dependency-service-exited-unexpectedly',
          },
        };
        return;
      }
      case 'stopped':
      case 'stopping':
      case 'failing':
      case 'failed':
      case 'detached': {
        return;
      }
      case 'depsStarting':
      case 'initial':
      case 'executingDeps':
      case 'fingerprinting':
      case 'stoppingAdoptee':
      case 'unstarted': {
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
        if (this._state.readyMonitor !== undefined) {
          this._state = {
            id: 'readying',
            child: this._state.child,
            fingerprint: this._state.fingerprint,
            started: this._state.started,
            readyMonitor: this._state.readyMonitor,
          };
          void this._state.readyMonitor.matched.then((result) => {
            if (result.ok) {
              this._onChildReady();
            }
            // Otherwise the ready monitor aborted, so we don't care.
          });
          return;
        }
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
      case 'stopping':
      case 'failing': {
        this._state.child.kill();
        return;
      }
      case 'initial':
      case 'executingDeps':
      case 'fingerprinting':
      case 'stoppingAdoptee':
      case 'unstarted':
      case 'depsStarting':
      case 'readying':
      case 'started':
      case 'stopped':
      case 'failed':
      case 'detached': {
        throw unexpectedState(this._state);
      }
      default: {
        throw unknownState(this._state);
      }
    }
  }

  private _onChildReady() {
    switch (this._state.id) {
      case 'readying': {
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
      case 'starting':
      case 'stopping':
      case 'failing':
      case 'initial':
      case 'executingDeps':
      case 'fingerprinting':
      case 'stoppingAdoptee':
      case 'unstarted':
      case 'depsStarting':
      case 'started':
      case 'stopped':
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
        this._enterStoppedState();
        this._logger.log({
          script: this._config,
          type: 'info',
          detail: 'service-stopped',
        });
        return;
      }
      case 'readying': {
        this._state.readyMonitor.abort();
        const event = {
          script: this._config,
          type: 'failure',
          reason: 'service-exited-unexpectedly',
        } as const;
        this._logger.log(event);
        this._enterFailedState(event);
        return;
      }
      case 'started': {
        const event = {
          script: this._config,
          type: 'failure',
          reason: 'service-exited-unexpectedly',
        } as const;
        this._logger.log(event);
        this._enterFailedState(event);
        return;
      }
      case 'failing': {
        this._logger.log({
          script: this._config,
          type: 'info',
          detail: 'service-stopped',
        });
        this._enterFailedState(this._state.failure);
        return;
      }
      case 'failed':
      case 'detached': {
        return;
      }
      case 'initial':
      case 'executingDeps':
      case 'fingerprinting':
      case 'stoppingAdoptee':
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

  /**
   * Stop this service if it has started, and return a promise that resolves
   * when it is stopped.
   */
  abort(): Promise<void> {
    switch (this._state.id) {
      case 'started': {
        this._state.child.kill();
        this._state = {
          id: 'stopping',
          child: this._state.child,
          fingerprint: this._state.fingerprint,
        };
        break;
      }
      case 'starting': {
        this._state.readyMonitor?.abort();
        this._state = {
          id: 'stopping',
          child: this._state.child,
          fingerprint: this._state.fingerprint,
        };
        break;
      }
      case 'readying': {
        this._state.readyMonitor.abort();
        this._state.child.kill();
        this._state = {
          id: 'stopping',
          child: this._state.child,
          fingerprint: this._state.fingerprint,
        };
        break;
      }
      case 'initial':
      case 'executingDeps':
      case 'fingerprinting':
      case 'stoppingAdoptee':
      case 'unstarted':
      case 'depsStarting': {
        this._enterStoppedState();
        break;
      }
      case 'stopping':
      case 'stopped':
      case 'failing':
      case 'failed':
      case 'detached': {
        break;
      }
      default: {
        throw unknownState(this._state);
      }
    }
    return this._terminated.promise.then(() => undefined);
  }

  private _enterStoppedState() {
    this._state = {id: 'stopped'};
    this._terminated.resolve({ok: true, value: undefined});
    this._servicesNotNeeded.resolve();
  }

  private _enterFailedState(failure: Failure) {
    this._state = {
      id: 'failed',
      failure,
    };
    this._executor.notifyFailure();
    this._terminated.resolve({ok: false, error: failure});
    this._servicesNotNeeded.resolve();
  }
}
