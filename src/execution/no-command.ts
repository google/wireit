/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseExecution} from './base.js';
import {Fingerprint} from '../fingerprint.js';

import type {ExecutionResult} from './base.js';
import type {NoCommandScriptConfig} from '../config.js';

/**
 * Execution for a {@link NoCommandScriptConfig}.
 */
export class NoCommandScriptExecution extends BaseExecution<NoCommandScriptConfig> {
  protected override async _execute(): Promise<ExecutionResult> {
    const dependencyFingerprints = await this._executeDependencies();
    if (!dependencyFingerprints.ok) {
      return dependencyFingerprints;
    }
    const fingerprint = await Fingerprint.compute(
      this._config,
      dependencyFingerprints.value,
    );
    this._logger.log({
      script: this._config,
      type: 'success',
      reason: 'no-command',
    });
    return {ok: true, value: fingerprint};
  }
}
