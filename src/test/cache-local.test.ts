/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import {registerCommonCacheTests} from './cache-common.js';

const test = suite<object>();

registerCommonCacheTests(test, 'local');

test.run();
