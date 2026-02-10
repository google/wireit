/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {registerCommonCacheTests} from './cache-common.js';
import {WireitTestRig} from './util/test-rig.js';

async function setup() {
  const rig = await WireitTestRig.setup();
  rig.env = {
    ...rig.env,
    WIREIT_CACHE: 'github',
    // We're testing against the actual production GitHub API, so we must pass
    // down access to the real credentials (normally our test rig removes any
    // WIREIT_ variables from being inherited).
    WIREIT_CACHE_GITHUB_CUSTODIAN_PORT:
      process.env.WIREIT_CACHE_GITHUB_CUSTODIAN_PORT,
  };
  return {
    rig,
    [Symbol.asyncDispose]: () => rig[Symbol.asyncDispose](),
  };
}

registerCommonCacheTests(setup, 'github');
