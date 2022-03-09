/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {test} from 'uvu';
import * as assert from 'uvu/assert';

test('always passes', () => {
  assert.is(true, true);
});

test.run();
