/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseExecutionWithCommand} from './base.js';
import {ComputeFingerprintResult, Fingerprint} from '../fingerprint.js';
import {Deferred} from '../util/deferred.js';
import {ScriptChildProcess} from '../script-child-process.js';
import {LineMonitor} from '../util/line-monitor.js';

import type {ExecutionResult} from './base.js';
import type {Dependency, ServiceScriptConfig} from '../config.js';
import type {Executor} from '../executor.js';
import type {Logger} from '../logging/logger.js';
import type {Failure, ServiceStoppedReason} from '../event.js';
import type {Result} from '../error.js';
import {NeedsToRunReason} from './standard.js';

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
      id: 'started-broken';
      child: ScriptChildProcess;
      fingerprint: Fingerprint;
      failure: Failure;
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
    `Unknown service state ${String((state as ServiceState).id)}`,
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
  #state: ServiceState;
  readonly config: ServiceScriptConfig;
  readonly #terminated = new Deferred<Result<void, Failure>>();
  readonly #isWatchMode: boolean;

  /**
   * Resolves as "ok" when this script decides it is no longer needed, and
   * either has begun shutting down, or never needed to start in the first
   * place.
   *
   * Resolves with an error if this service exited unexpectedly, or if any of
   * its own service dependencies exited unexpectedly.
   */
  readonly terminated = this.#terminated.promise;
  #stopReason: ServiceStoppedReason = {name: 'unknown'};

  constructor(
    config: ServiceScriptConfig,
    executor: Executor,
    logger: Logger,
    entireExecutionAborted: Promise<void>,
    adoptee: ServiceScriptExecution | undefined,
    isWatchMode: boolean,
  ) {
    super(config, executor, logger);
    this.config = config;
    this.#isWatchMode = isWatchMode;
    this.#state = {
      id: 'initial',
      entireExecutionAborted,
      adoptee,
    };
    // Doing this here ensures that we always log when the
    // service stops, no matter how that happens.
    void this.#terminated.promise.then((result) => {
      const failure = result.ok ? undefined : result.error;
      this._logger.log({
        script: this._config,
        type: 'info',
        detail: 'service-stopped',
        reason: this.#stopReason,
        failure,
      });
    });
  }

  /**
   * Return the fingerprint of this service. Throws if the fingerprint is not
   * yet available. Returns undefined if the service is stopped/failed/detached.
   */
  get fingerprint(): Fingerprint | undefined {
    switch (this.#state.id) {
      case 'stoppingAdoptee':
      case 'unstarted':
      case 'depsStarting':
      case 'starting':
      case 'readying':
      case 'started':
      case 'started-broken':
      case 'stopping':
      case 'failing': {
        return this.#state.fingerprint;
      }
      case 'stopped':
      case 'failed': {
        return;
      }
      case 'initial':
      case 'executingDeps':
      case 'fingerprinting':
      case 'detached': {
        throw unexpectedState(this.#state);
      }
      default: {
        throw unknownState(this.#state);
      }
    }
  }

  /**
   * Take over ownership of this service's running child process, if there is
   * one.
   */
  detach(): {child: ScriptChildProcess; fingerprint: Fingerprint} | undefined {
    switch (this.#state.id) {
      case 'started':
      case 'started-broken':
      case 'stopping':
      case 'failing': {
        const {child, fingerprint} = this.#state;
        this.#state = {id: 'detached'};
        this.#stopLoggingChildStdio(child);
        return {child, fingerprint};
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
        throw unexpectedState(this.#state);
      }
      default: {
        throw unknownState(this.#state);
      }
    }
  }

  /**
   * Note `execute` is a bit of a misnomer here, because we don't actually
   * execute the command at this stage in the case of services.
   */
  protected override _execute(): Promise<ExecutionResult> {
    switch (this.#state.id) {
      case 'initial': {
        const allConsumersDone = Promise.all(
          this._config.serviceConsumers.map(
            (consumer) =>
              this._executor.getExecution(consumer).servicesNotNeeded,
          ),
        );
        const abort = this._config.isPersistent
          ? Promise.all([this.#state.entireExecutionAborted, allConsumersDone])
          : allConsumersDone;
        void abort.then(() => {
          void this.abort(
            this._config.isPersistent
              ? {name: 'the run was aborted'}
              : {name: 'all consumers of the service are done'},
          );
        });

        this.#state = {
          id: 'executingDeps',
          deferredFingerprint: new Deferred(),
          adoptee: this.#state.adoptee,
        };
        void this._executeDependencies().then((result) => {
          if (result.ok) {
            this.#onDepsExecuted(result.value);
          } else {
            this.#onDepExecErr(result);
          }
        });
        return this.#state.deferredFingerprint.promise;
      }
      case 'executingDeps':
      case 'fingerprinting':
      case 'stoppingAdoptee':
      case 'unstarted':
      case 'depsStarting':
      case 'starting':
      case 'readying':
      case 'started':
      case 'started-broken':
      case 'stopping':
      case 'stopped':
      case 'failed':
      case 'failing':
      case 'detached': {
        throw unexpectedState(this.#state);
      }
      default: {
        throw unknownState(this.#state);
      }
    }
  }

  #onDepsExecuted(depFingerprints: Array<[Dependency, Fingerprint]>): void {
    switch (this.#state.id) {
      case 'executingDeps': {
        this.#state = {
          id: 'fingerprinting',
          deferredFingerprint: this.#state.deferredFingerprint,
          adoptee: this.#state.adoptee,
        };
        void Fingerprint.compute(this._config, depFingerprints).then(
          (result) => {
            this.#onFingerprinted(result);
          },
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
      case 'started-broken':
      case 'stopping':
      case 'failing':
      case 'detached': {
        throw unexpectedState(this.#state);
      }
      default: {
        throw unknownState(this.#state);
      }
    }
  }

  #onDepExecErr(result: ExecutionResult & {ok: false}) {
    switch (this.#state.id) {
      case 'executingDeps': {
        this.#state.deferredFingerprint.resolve(result);
        const failure = result.error[0]!;
        const detached = this.#state.adoptee?.detach();
        if (detached !== undefined) {
          this.#enterStartedBrokenState(failure, detached);
        } else {
          this.#enterFailedState(failure);
        }
        return;
      }
      case 'started-broken':
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
        throw unexpectedState(this.#state);
      }
      default: {
        throw unknownState(this.#state);
      }
    }
  }

  #needsToBeRestarted(
    computeResult: ComputeFingerprintResult,
    adoptee: ServiceScriptExecution | undefined,
  ): undefined | NeedsToRunReason {
    if (computeResult.notFullyTrackedReason !== undefined) {
      return {
        name: 'not-fully-tracked',
        reason: computeResult.notFullyTrackedReason,
      };
    }
    const fingerprint = computeResult.fingerprint;
    const prevFingerprint = adoptee?.fingerprint;
    if (prevFingerprint === undefined) {
      return {name: 'no-previous-fingerprint'};
    }
    const difference = fingerprint.difference(prevFingerprint);
    if (difference === undefined) {
      return undefined;
    }
    return {
      name: 'fingerprints-differed',
      difference,
    };
  }

  #onFingerprinted(computeResult: ComputeFingerprintResult) {
    const fingerprint = computeResult.fingerprint;
    switch (this.#state.id) {
      case 'fingerprinting': {
        const adoptee = this.#state.adoptee;
        const needsToRestartReason = this.#needsToBeRestarted(
          computeResult,
          adoptee,
        );
        if (adoptee !== undefined && needsToRestartReason !== undefined) {
          // There is a previous running version of this service, but the
          // fingerprint changed, so we need to restart it.
          this.#state = {
            id: 'stoppingAdoptee',
            fingerprint,
            deferredFingerprint: this.#state.deferredFingerprint,
          };
          // deleted the `void` as a deliberate lint warning so I come back and
          // include info on
          // what changed in the fingerprint
          adoptee
            ?.abort({name: 'restart', reason: needsToRestartReason})
            .then(() => {
              this.#onAdopteeStopped();
            });
          return;
        }
        this.#state.deferredFingerprint.resolve({
          ok: true,
          value: fingerprint,
        });
        this.#state = {
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
      case 'started-broken':
      case 'stopping':
      case 'failing':
      case 'detached': {
        throw unexpectedState(this.#state);
      }
      default: {
        throw unknownState(this.#state);
      }
    }
  }

  #onAdopteeStopped() {
    switch (this.#state.id) {
      case 'stoppingAdoptee': {
        this.#state.deferredFingerprint.resolve({
          ok: true,
          value: this.#state.fingerprint,
        });
        this.#state = {
          id: 'unstarted',
          fingerprint: this.#state.fingerprint,
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
      case 'started-broken':
      case 'stopping':
      case 'failing':
      case 'detached': {
        throw unexpectedState(this.#state);
      }
      default: {
        throw unknownState(this.#state);
      }
    }
  }

  /**
   * Start this service if it isn't already started.
   */
  start(): Promise<Result<void, Failure>> {
    switch (this.#state.id) {
      case 'unstarted': {
        const started = new Deferred<Result<void, Failure>>();
        this.#state = {
          id: 'depsStarting',
          started,
          fingerprint: this.#state.fingerprint,
          adoptee: this.#state.adoptee,
        };
        void this._startServices().then((result) => {
          if (result.ok) {
            this.#onDepsStarted();
          } else {
            this.#onDepStartErr(result);
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
                },
          );
        });
        return this.#state.started.promise;
      }
      case 'depsStarting':
      case 'starting':
      case 'readying': {
        return this.#state.started.promise;
      }
      case 'started': {
        return Promise.resolve({ok: true, value: undefined});
      }
      case 'started-broken':
      case 'failing':
      case 'failed': {
        return Promise.resolve({ok: false, error: this.#state.failure});
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
        throw unexpectedState(this.#state);
      }
      default: {
        throw unknownState(this.#state);
      }
    }
  }

  #onDepsStarted() {
    switch (this.#state.id) {
      case 'depsStarting': {
        const detached = this.#state.adoptee?.detach();
        if (detached === undefined) {
          const child = new ScriptChildProcess(this._config);
          this.#state = {
            id: 'starting',
            child,
            started: this.#state.started,
            fingerprint: this.#state.fingerprint,
            readyMonitor:
              this._config.service.readyWhen.lineMatches === undefined
                ? undefined
                : new LineMonitor(
                    child,
                    this._config.service.readyWhen.lineMatches,
                  ),
          };
          void this.#state.child.started.then(() => {
            this.#onChildStarted();
          });
        } else {
          this.#state.started.resolve({ok: true, value: undefined});
          this.#state = {
            id: 'started',
            child: detached.child,
            fingerprint: this.#state.fingerprint,
          };
        }
        void this.#state.child.completed.then(() => {
          this.#onChildExited();
        });
        this.#startLoggingChildStdio(this.#state.child);
        if (!this.#isWatchMode) {
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
            this.#onDepServiceExit();
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
      case 'started-broken':
      case 'stopping':
      case 'stopped':
      case 'failing':
      case 'detached': {
        throw unexpectedState(this.#state);
      }
      default: {
        throw unknownState(this.#state);
      }
    }
  }

  #onDepStartErr(result: {ok: false; error: Failure[]}) {
    switch (this.#state.id) {
      case 'depsStarting': {
        // TODO(aomarks) The inconsistency between using single vs multiple
        // failure result types is inconvenient. It's ok to just use the first
        // one here, but would make more sense to return all of them.
        const failure = result.error[0]!;
        const detached = this.#state.adoptee?.detach();
        if (detached !== undefined) {
          this.#enterStartedBrokenState(failure, detached);
        } else {
          this.#enterFailedState(failure);
        }
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
      case 'started-broken':
      case 'detached': {
        throw unexpectedState(this.#state);
      }
      default: {
        throw unknownState(this.#state);
      }
    }
  }

  #onDepServiceExit() {
    switch (this.#state.id) {
      case 'started':
      case 'started-broken': {
        this.#state.child.kill();
        this.#state = {
          id: 'failing',
          child: this.#state.child,
          fingerprint: this.#state.fingerprint,
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
        this.#state = {
          id: 'failing',
          child: this.#state.child,
          fingerprint: this.#state.fingerprint,
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
        throw unexpectedState(this.#state);
      }
      default: {
        throw unknownState(this.#state);
      }
    }
  }

  #onChildStarted() {
    switch (this.#state.id) {
      case 'starting': {
        this._logger.log({
          script: this._config,
          type: 'info',
          detail: 'service-process-started',
        });
        if (this.#state.readyMonitor !== undefined) {
          this.#state = {
            id: 'readying',
            child: this.#state.child,
            fingerprint: this.#state.fingerprint,
            started: this.#state.started,
            readyMonitor: this.#state.readyMonitor,
          };
          void this.#state.readyMonitor.matched.then((result) => {
            if (result.ok) {
              this.#onChildReady();
            }
            // Otherwise the ready monitor aborted, so we don't care.
          });
          return;
        }
        this.#state.started.resolve({ok: true, value: undefined});
        this._logger.log({
          script: this._config,
          type: 'info',
          detail: 'service-ready',
        });
        this.#state = {
          id: 'started',
          child: this.#state.child,
          fingerprint: this.#state.fingerprint,
        };
        return;
      }
      case 'stopping':
      case 'failing': {
        this.#state.child.kill();
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
      case 'started-broken':
      case 'stopped':
      case 'failed':
      case 'detached': {
        throw unexpectedState(this.#state);
      }
      default: {
        throw unknownState(this.#state);
      }
    }
  }

  #onChildReady() {
    switch (this.#state.id) {
      case 'readying': {
        this.#state.started.resolve({ok: true, value: undefined});
        this._logger.log({
          script: this._config,
          type: 'info',
          detail: 'service-ready',
        });
        this.#state = {
          id: 'started',
          child: this.#state.child,
          fingerprint: this.#state.fingerprint,
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
      case 'started-broken':
      case 'stopped':
      case 'failed':
      case 'detached': {
        throw unexpectedState(this.#state);
      }
      default: {
        throw unknownState(this.#state);
      }
    }
  }

  #onChildExited() {
    switch (this.#state.id) {
      case 'stopping': {
        this.#enterStoppedState();
        return;
      }
      case 'readying': {
        this.#state.readyMonitor.abort();
        const event = {
          script: this._config,
          type: 'failure',
          reason: 'service-exited-unexpectedly',
        } as const;
        this._logger.log(event);
        this.#enterFailedState(event);
        return;
      }
      case 'started':
      case 'started-broken': {
        const event = {
          script: this._config,
          type: 'failure',
          reason: 'service-exited-unexpectedly',
        } as const;
        this._logger.log(event);
        this.#enterFailedState(event);
        return;
      }
      case 'failing': {
        this.#enterFailedState(this.#state.failure);
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
        throw unexpectedState(this.#state);
      }
      default: {
        throw unknownState(this.#state);
      }
    }
  }

  /**
   * Stop this service if it has started, and return a promise that resolves
   * when it is stopped.
   */
  abort(reason: ServiceStoppedReason): Promise<void> {
    this.#stopReason = reason;
    switch (this.#state.id) {
      case 'started':
      case 'started-broken': {
        this.#state.child.kill();
        this.#state = {
          id: 'stopping',
          child: this.#state.child,
          fingerprint: this.#state.fingerprint,
        };
        break;
      }
      case 'starting': {
        this.#state.readyMonitor?.abort();
        this.#state = {
          id: 'stopping',
          child: this.#state.child,
          fingerprint: this.#state.fingerprint,
        };
        break;
      }
      case 'readying': {
        this.#state.readyMonitor.abort();
        this.#state.child.kill();
        this.#state = {
          id: 'stopping',
          child: this.#state.child,
          fingerprint: this.#state.fingerprint,
        };
        break;
      }
      case 'initial':
      case 'executingDeps':
      case 'fingerprinting':
      case 'stoppingAdoptee':
      case 'unstarted':
      case 'depsStarting': {
        this.#enterStoppedState();
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
        throw unknownState(this.#state);
      }
    }
    return this.#terminated.promise.then(() => undefined);
  }

  #enterStoppedState() {
    this.#state = {id: 'stopped'};
    this.#terminated.resolve({ok: true, value: undefined});
    this._servicesNotNeeded.resolve();
  }

  #enterFailedState(failure: Failure) {
    this.#state = {
      id: 'failed',
      failure,
    };
    this._executor.notifyFailure();
    this.#terminated.resolve({ok: false, error: failure});
    this._servicesNotNeeded.resolve();
  }

  #enterStartedBrokenState(
    failure: Failure,
    {child, fingerprint}: {child: ScriptChildProcess; fingerprint: Fingerprint},
  ) {
    this.#startLoggingChildStdio(child);
    void child.completed.then(() => {
      this.#onChildExited();
    });
    this.#state = {
      id: 'started-broken',
      child,
      fingerprint,
      failure,
    };
  }

  #startLoggingChildStdio(child: ScriptChildProcess) {
    child.stdout.on('data', (data: string | Buffer) => {
      this._logger.log({
        script: this._config,
        type: 'output',
        stream: 'stdout',
        data,
      });
    });
    child.stderr.on('data', (data: string | Buffer) => {
      this._logger.log({
        script: this._config,
        type: 'output',
        stream: 'stderr',
        data,
      });
    });
  }

  #stopLoggingChildStdio(child: ScriptChildProcess) {
    // Note that for some reason, removing all listeners from stdout/stderr
    // without specifying the "data" event will also remove the listeners
    // directly on "child" inside the ScriptChildProceess for noticing when e.g.
    // the process has exited.
    child.stdout.removeAllListeners('data');
    child.stderr.removeAllListeners('data');
  }
}
