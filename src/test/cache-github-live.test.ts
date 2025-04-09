/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {registerCommonCacheTests} from './cache-common.js';
import {rigTest} from './util/rig-test.js';
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
      // down access to the real credentials (normally our test rig strips any
      // WIREIT_ variables).
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

registerCommonCacheTests(test, 'github-live');

test(
  'cache key affected by ImageOS environment variable',
  rigTest(async ({rig}) => {
    const cmdA = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            files: ['input'],
            output: ['output'],
          },
        },
      },
      input: 'v0',
    });

    // Initial run with input v0 and OS ubuntu18.
    {
      const exec = rig.exec('npm run a', {env: {ImageOS: 'ubuntu18'}});
      const inv = await cmdA.nextInvocation();
      await rig.write({output: 'v0'});
      inv.exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 1);
      assert.equal(await rig.read('output'), 'v0');
    }

    // Input changed to v1. Run again.
    {
      await rig.write({input: 'v1'});
      const exec = rig.exec('npm run a', {env: {ImageOS: 'ubuntu18'}});
      const inv = await cmdA.nextInvocation();
      await rig.write({output: 'v1'});
      inv.exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 2);
      assert.equal(await rig.read('output'), 'v1');
    }

    // Input changed back to v0, but OS is now ubuntu20. Output should not be
    // cached, because we changed OS.
    {
      await rig.write({input: 'v0'});
      const exec = rig.exec('npm run a', {env: {ImageOS: 'ubuntu20'}});
      const inv = await cmdA.nextInvocation();
      assert.not(await rig.exists('output'));
      inv.exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 3);
    }
  }),
);

test.run();
