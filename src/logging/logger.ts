/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import type {Event} from '../event.js';

/**
 * Logs Wireit events in some way.
 */
export interface Logger {
  log(event: Event): void;
}
