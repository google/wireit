/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Event} from '../event.js';

/**
 * Logs Wireit events in some way.
 */
export interface Logger {
  log(event: Event): void;
  printMetrics(): void;

  // Some loggers need additional logic when run in watch mode.
  // If this method is present, we'll call it and use the result when in
  // watch mode.
  getWatchLogger?(): Logger;
}
