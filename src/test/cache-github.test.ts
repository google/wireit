/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import * as assert from 'uvu/assert';
import {suite} from 'uvu';
import {WireitTestRig} from './util/test-rig.js';
import {registerCommonCacheTests} from './cache-common.js';
import {FakeGitHubActionsCacheServer} from './util/fake-github-actions-cache-server.js';
import {timeout} from './util/uvu-timeout.js';

const test = suite<{
  rig: WireitTestRig;
  server: FakeGitHubActionsCacheServer;
}>();

test.before.each(async (ctx) => {
  try {
    const authToken = String(Math.random()).slice(2);
    ctx.server = new FakeGitHubActionsCacheServer(authToken);
    await ctx.server.listen();
    ctx.rig = new WireitTestRig();
    ctx.rig.env = {
      WIREIT_CACHE: 'github',
      ACTIONS_CACHE_URL: `http://localhost:${ctx.server.port}/`,
      ACTIONS_RUNTIME_TOKEN: authToken,
      RUNNER_TEMP: pathlib.join(ctx.rig.temp, 'github-cache-temp'),
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
    await Promise.all([ctx.server.close(), ctx.rig.cleanup()]);
  } catch (error) {
    // Uvu has a bug where it silently ignores failures in before and after,
    // see https://github.com/lukeed/uvu/issues/191.
    console.error('uvu after error', error);
    process.exit(1);
  }
});

registerCommonCacheTests(test, 'github');

test(
  'cache key affected by ImageOS environment variable',
  timeout(async ({rig}) => {
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

    // Input changed back to v0, but OS is now ubuntu18. Output should not be
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
  })
);

test(
  'recovers from reservation race condition',
  timeout(async ({rig, server}) => {
    const cmdA = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            files: [],
            output: ['output'],
          },
        },
      },
    });

    // Start n Wireit processes for the same script at the same time.
    const n = 5;
    const execs = [];
    const invs = [];
    for (let i = 0; i < n; i++) {
      execs.push(rig.exec('npm run a'));
      invs.push(cmdA.nextInvocation());
    }

    // Wait for all script invocations to start.
    const started = await Promise.all(invs);

    // Write some output that we expect to get cached.
    await rig.write({output: 'v0'});

    // Have all scripts exit at approximately the same time. This will trigger
    // the race condition, because every script has already called "get" and saw
    // a cache miss, and will now all call "set" to try and reserve and save the
    // cache entry. But only one of them will get the reservation, the others
    // should just continue without error.
    for (const inv of started) {
      inv.exit(0);
    }

    // All Wireit processes should successfully exit, even if the race condition
    // occured.
    for (const exec of execs) {
      assert.equal((await exec.exit).code, 0);
    }
    assert.equal(cmdA.numInvocations, n);
    assert.equal(server.metrics, {
      check: n,
      reserve: n,
      upload: 1,
      commit: 1,
      download: 0,
    });

    // Delete the ".wireit" folder so that the next run won't be considered
    // fresh, and the "output" file so that we can be sure it gets restored from
    // cache.
    await rig.delete('.wireit');
    await rig.delete('output');

    // Do a final run to confirm that one of the scripts saved the cache.
    const exec = rig.exec('npm run a');
    assert.equal((await exec.exit).code, 0);
    assert.equal(await rig.read('output'), 'v0');
    assert.equal(cmdA.numInvocations, n);
    assert.equal(server.metrics, {
      check: n + 1,
      reserve: n,
      upload: 1,
      commit: 1,
      download: 1,
    });
  })
);

test.run();
