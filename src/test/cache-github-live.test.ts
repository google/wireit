/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import {registerCommonCacheTests} from './cache-common.js';
import {WireitTestRig} from './util/test-rig.js';

const test = suite<{
  rig: WireitTestRig;
}>();

test.before.each(async (ctx) => {
  try {
    ctx.rig = new WireitTestRig();
    ctx.rig.env = {
      ...ctx.rig.env,
      WIREIT_CACHE: 'github',
      // We're testing against the actual production GitHub API, so we must pass
      // down access to the real credentials (normally our test rig removes any
      // WIREIT_ variables from being inherited).
      WIREIT_CACHE_GITHUB_CUSTODIAN_PORT:
        process.env.WIREIT_CACHE_GITHUB_CUSTODIAN_PORT,
    };
    await ctx.rig.setup();
  } catch (error) {
    // Uvu has a bug where it silently ignores failures in before and after,
    // see https://github.com/lukeed/uvu/issues/191.
    console.error('uvu before error', error);
    process.exit(1);
  }
});

test.after.each(async (ctx) => {
  try {
    await ctx.rig.cleanup();
  } catch (error) {
    // Uvu has a bug where it silently ignores failures in before and after,
    // see https://github.com/lukeed/uvu/issues/191.
    console.error('uvu after error', error);
    process.exit(1);
  }
});

registerCommonCacheTests(test, 'github');

test.run();
