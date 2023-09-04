/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../event.js';
import {DefaultLogger} from './default-logger.js';
import {Logger} from './logger.js';

export class ExplainLogger extends DefaultLogger {
  override log(event: Event): void {
    super.log(event);
  }

  override printMetrics(): void {
    return;
  }

  override getWatchLogger(): Logger {
    // Don't use watchLogger, we don't want to clear the terminal.
    return this;
  }
}
