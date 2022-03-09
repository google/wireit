/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {Event} from './events.js';

export interface Logger {
  log(event: Event): void;
}
