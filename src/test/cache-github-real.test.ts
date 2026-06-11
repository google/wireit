/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {test} from 'node:test';
import {registerCommonCacheTests} from './cache-common.js';

registerCommonCacheTests((...args) => void test(...args), 'github', {
  WIREIT_CACHE: 'github',
  // We're testing against the actual production GitHub API, so we must pass
  // down access to the real credentials (normally our test rig removes any
  // WIREIT_ variables from being inherited).
  WIREIT_CACHE_GITHUB_CUSTODIAN_PORT:
    process.env.WIREIT_CACHE_GITHUB_CUSTODIAN_PORT,
});
