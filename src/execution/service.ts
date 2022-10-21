/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseExecutionWithCommand} from './base.js';
import {Fingerprint} from '../fingerprint.js';

import type {ExecutionResult} from './base.js';
import type {ServiceScriptConfig} from '../config.js';
import type {Executor} from '../executor.js';
import type {Logger} from '../logging/logger.js';
import type {Failure} from '../event.js';
import type {Result} from '../error.js';

/**
 * Execution for a {@link ServiceScriptConfig}.
 */
export class ServiceScriptExecution extends BaseExecutionWithCommand<ServiceScriptConfig> {
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
  protected override async _execute(): Promise<ExecutionResult> {
    const dependencyFingerprints = await this._executeDependencies();
    if (!dependencyFingerprints.ok) {
      return dependencyFingerprints;
    }
    const fingerprint = await Fingerprint.compute(
      this._config,
      dependencyFingerprints.value
    );
    return {ok: true, value: fingerprint};
  }

  /**
   * Start this service if it isn't already started.
   */
  start(): Promise<Result<void, Failure[]>> {
    // TODO(aomarks) Implement service starting/stopping.
    throw new Error('Not implemented');
  }
}
