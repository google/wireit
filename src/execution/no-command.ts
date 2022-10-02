/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseExecution} from './base.js';
import {Fingerprint} from '../fingerprint.js';

import type {ExecutionResult} from './base.js';
import type {Executor} from '../executor.js';
import type {NoCommandScriptConfig} from '../script.js';
import type {Logger} from '../logging/logger.js';

/**
 * Execution for a {@link NoCommandScriptConfig}.
 */
export class NoCommandScriptExecution extends BaseExecution<NoCommandScriptConfig> {
  static execute(
    script: NoCommandScriptConfig,
    executor: Executor,
    logger: Logger
  ): Promise<ExecutionResult> {
    return new NoCommandScriptExecution(script, executor, logger).#execute();
  }

  async #execute(): Promise<ExecutionResult> {
    const dependencyFingerprints = await this.executeDependencies();
    if (!dependencyFingerprints.ok) {
      return dependencyFingerprints;
    }
    const fingerprint = await Fingerprint.compute(
      this.script,
      dependencyFingerprints.value
    );
    this.logger.log({
      script: this.script,
      type: 'success',
      reason: 'no-command',
    });
    return {ok: true, value: fingerprint};
  }
}
