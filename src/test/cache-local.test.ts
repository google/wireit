/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {test} from 'node:test';
import {registerCommonCacheTests} from './cache-common.js';

registerCommonCacheTests(test, 'local');
