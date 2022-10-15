/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseExecution} from './base.js';
import {Fingerprint} from '../fingerprint.js';

import type {ExecutionResult} from './base.js';
import type {Executor} from '../executor.js';
import type {ServiceScriptConfig} from '../config.js';
import type {Logger} from '../logging/logger.js';

/**
 * Execution for a {@link ServiceScriptConfig}.
 */
export class ServiceScriptExecution extends BaseExecution<ServiceScriptConfig> {
  static execute(
    script: ServiceScriptConfig,
    executor: Executor,
    logger: Logger
  ): Promise<ExecutionResult> {
    return new ServiceScriptExecution(script, executor, logger)._execute();
  }

  private async _execute(): Promise<ExecutionResult> {
    const dependencyFingerprints = await this.executeDependencies();
    if (!dependencyFingerprints.ok) {
      return dependencyFingerprints;
    }
    const fingerprint = await Fingerprint.compute(
      this.script,
      dependencyFingerprints.value
    );
    return {ok: true, value: fingerprint};
  }

  // TODO(aomarks) Implement service starting/stopping.
}
