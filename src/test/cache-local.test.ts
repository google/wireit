/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {registerCommonCacheTests} from './cache-common.js';
import {WireitTestRig} from './util/test-rig.js';

async function setup() {
  const rig = await WireitTestRig.setup();
  return {
    rig,
    [Symbol.asyncDispose]: () => rig[Symbol.asyncDispose](),
  };
}

registerCommonCacheTests(setup, 'local');
