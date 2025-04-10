/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as pathlib from 'path';
import * as assert from 'uvu/assert';
import * as crypto from 'crypto';
import * as selfsigned from 'selfsigned';
import {suite} from 'uvu';
import {fileURLToPath} from 'url';
import {ExitResult, WireitTestRig} from './util/test-rig.js';
import {registerCommonCacheTests} from './cache-common.js';
import {
  FakeGitHubActionsCacheServer,
  type FakeGitHubActionsCacheServerMetrics,
} from './util/fake-github-actions-cache-server.js';
import {rigTest, DEFAULT_UVU_TIMEOUT} from './util/rig-test.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathlib.dirname(__filename);
const repoRoot = pathlib.resolve(__dirname, '..', '..');

const SELF_SIGNED_CERT = selfsigned.generate(
  [{name: 'commonName', value: 'localhost'}],
  // More recent versions of TLS require a larger minimum key size than the
  // default of this library (1024). Let's also upgrade from sha1 to sha256
  // while we're at it.
  {keySize: 2048, algorithm: 'sha256'},
);
const SELF_SIGNED_CERT_PATH = pathlib.resolve(
  repoRoot,
  'temp',
  'self-signed.cert',
);

const test = suite<{
  rig: WireitTestRig;
  server: FakeGitHubActionsCacheServer;
}>();

test.before(async () => {
  await fs.mkdir(pathlib.dirname(SELF_SIGNED_CERT_PATH), {recursive: true});
  await fs.writeFile(SELF_SIGNED_CERT_PATH, SELF_SIGNED_CERT.cert);
});

test.before.each(async (ctx) => {
  try {
    // Set up the cache service for each test (as opposed to for the whole
    // suite) because we want fresh cache state for each test.
    const authToken = String(Math.random()).slice(2);
    ctx.server = new FakeGitHubActionsCacheServer(authToken, {
      cert: SELF_SIGNED_CERT.cert,
      key: SELF_SIGNED_CERT.private,
    });
    const actionsCacheUrl = await ctx.server.listen();
    ctx.rig = new WireitTestRig();
    ctx.rig.env = {
      ...ctx.rig.env,
      WIREIT_CACHE: 'github',
      ACTIONS_RESULTS_URL: actionsCacheUrl,
      ACTIONS_RUNTIME_TOKEN: authToken,
      RUNNER_TEMP: pathlib.join(ctx.rig.temp, 'github-cache-temp'),
      // Tell Node to trust our self-signed certificate for HTTPS.
      NODE_EXTRA_CA_CERTS: SELF_SIGNED_CERT_PATH,
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

test(
  'recovers from reservation race condition',
  rigTest(async ({rig, server}) => {
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
            // Set empty output so that Wireit doesn't try to serialize all of
            // our "npm run" commands. Note that we *do* cache empty output, so
            // this is still covering the important part of this test.
            output: [],
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
      getCacheEntry: n,
      createCacheEntry: n,
      putBlobBlock: 1,
      putBlobBlockList: 1,
      finalizeCacheEntry: 1,
      getBlob: 0,
    } satisfies FakeGitHubActionsCacheServerMetrics);

    // Delete the ".wireit" folder so that the next run won't be considered
    // fresh, and the "output" file so that we can be sure it gets restored from
    // cache.
    await rig.delete('.wireit');

    // Do a final run to confirm that one of the scripts saved the cache.
    const exec = rig.exec('npm run a');
    assert.equal((await exec.exit).code, 0);
    assert.equal(cmdA.numInvocations, n);
    assert.equal(server.metrics, {
      getCacheEntry: n + 1,
      createCacheEntry: n,
      putBlobBlock: 1,
      putBlobBlockList: 1,
      finalizeCacheEntry: 1,
      getBlob: 1,
    } satisfies FakeGitHubActionsCacheServerMetrics);
  }),
);

function assertSuccess(exitResult: ExitResult) {
  if (exitResult.code !== 0) {
    console.error(exitResult.stdout);
    console.error(exitResult.stderr);
    throw new Error(`Expected exit code 0, got ${exitResult.code}`);
  }
}

for (const code of [429, 503, 'ECONNRESET'] as const) {
  test(
    `recovers from ${code} error`,
    rigTest(async ({rig, server}) => {
      await rig.write({
        'package.json': {
          scripts: {
            a: 'wireit',
            b: 'wireit',
          },
          wireit: {
            a: {
              command: 'true',
              files: ['input'],
              output: [],
              dependencies: ['b'],
            },
            b: {
              command: 'true',
              files: ['input'],
              output: [],
            },
          },
        },
      });

      // Do a successful run to populate the cache.
      await rig.write('input', 'cached');
      assertSuccess(await rig.exec('npm run a').exit);
      assert.equal(server.metrics, {
        getCacheEntry: 2,
        createCacheEntry: 2,
        putBlobBlock: 2,
        putBlobBlockList: 2,
        finalizeCacheEntry: 2,
        getBlob: 0,
      } satisfies FakeGitHubActionsCacheServerMetrics);

      // Check API
      server.forceErrorOnNextRequest('getCacheEntry', code);
      server.resetMetrics();
      await rig.write('input', '0');
      assertSuccess(await rig.exec('npm run a').exit);
      assert.equal(server.metrics, {
        // Note that because we turn off GitHub Actions Caching after the first
        // rate limit error, "b" fails and then "a" skips, so this count is 1
        // instead of 2.
        getCacheEntry: 1,
        createCacheEntry: 0,
        putBlobBlock: 0,
        putBlobBlockList: 0,
        finalizeCacheEntry: 0,
        getBlob: 0,
      } satisfies FakeGitHubActionsCacheServerMetrics);

      // Reserve API
      server.forceErrorOnNextRequest('createCacheEntry', code);
      server.resetMetrics();
      await rig.write('input', '1');
      assertSuccess(await rig.exec('npm run a').exit);
      assert.equal(server.metrics, {
        getCacheEntry: 1,
        createCacheEntry: 1,
        putBlobBlock: 0,
        putBlobBlockList: 0,
        finalizeCacheEntry: 0,
        getBlob: 0,
      } satisfies FakeGitHubActionsCacheServerMetrics);

      // Upload API
      server.forceErrorOnNextRequest('putBlobBlock', code);
      server.resetMetrics();
      await rig.write('input', '2');
      assertSuccess(await rig.exec('npm run a').exit);
      assert.equal(server.metrics, {
        getCacheEntry: 1,
        createCacheEntry: 1,
        putBlobBlock: 1,
        putBlobBlockList: 0,
        finalizeCacheEntry: 0,
        getBlob: 0,
      } satisfies FakeGitHubActionsCacheServerMetrics);

      // Commit API
      server.forceErrorOnNextRequest('finalizeCacheEntry', code);
      server.resetMetrics();
      await rig.write('input', '3');
      assertSuccess(await rig.exec('npm run a').exit);
      assert.equal(server.metrics, {
        getCacheEntry: 1,
        createCacheEntry: 1,
        putBlobBlock: 1,
        putBlobBlockList: 1,
        finalizeCacheEntry: 1,
        getBlob: 0,
      } satisfies FakeGitHubActionsCacheServerMetrics);

      // Download API
      server.forceErrorOnNextRequest('getBlob', code);
      server.resetMetrics();
      await rig.write('input', 'cached');
      assertSuccess(await rig.exec('npm run a').exit);
      assert.equal(server.metrics, {
        getCacheEntry: 2,
        createCacheEntry: 0,
        putBlobBlock: 0,
        putBlobBlockList: 0,
        finalizeCacheEntry: 0,
        getBlob: 2,
      } satisfies FakeGitHubActionsCacheServerMetrics);
    }),
  );
}

test(
  'uploads large tarball in multiple chunks',
  rigTest(
    async ({rig, server}) => {
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
      });

      // Generate a random file which is big enough to exceed the maximum chunk
      // size, so that it gets split into 2 separate upload requests.
      //
      // The maximum chunk size is defined here:
      // https://github.com/actions/toolkit/blob/500d0b42fee2552ae9eeb5933091fe2fbf14e72d/packages/cache/src/options.ts#L59
      //
      // This needs to be actually random data, not just arbitrary, because the
      // tarball will be compressed, and we need a poor compression ratio in order
      // to hit our target size.
      const MB = 1024 * 1024;
      const maxChunkBytes = 32 * MB;
      const compressionHeadroomBytes = 8 * MB; // Found experimentally.
      const totalBytes = maxChunkBytes + compressionHeadroomBytes;
      const fileContent = crypto.randomBytes(totalBytes).toString();

      // On the initial run a large file is created and should be cached.
      {
        await rig.write('input', 'v0');
        server.resetMetrics();

        const exec = rig.exec('npm run a');
        const inv = await cmdA.nextInvocation();
        await rig.write('output', fileContent);
        inv.exit(0);

        // Note here is when we are creating the compressed tarball, which is the
        // slowest part of this test.

        assert.equal((await exec.exit).code, 0);
        assert.equal(cmdA.numInvocations, 1);
        assert.equal(server.metrics, {
          getCacheEntry: 1,
          createCacheEntry: 1,
          // Since we had a file that was larger than the maximum chunk size, we
          // should have 2 upload requests.
          putBlobBlock: 2,
          putBlobBlockList: 1,
          finalizeCacheEntry: 1,
          getBlob: 0,
        } satisfies FakeGitHubActionsCacheServerMetrics);
      }

      // Invalidate cache by changing input.
      {
        await rig.write('input', 'v1');
        server.resetMetrics();

        const exec = rig.exec('npm run a');
        const inv = await cmdA.nextInvocation();
        assert.not(await rig.exists('output'));
        inv.exit(0);

        assert.equal((await exec.exit).code, 0);
        assert.equal(cmdA.numInvocations, 2);
        assert.equal(server.metrics, {
          getCacheEntry: 1,
          createCacheEntry: 1,
          putBlobBlock: 1,
          putBlobBlockList: 1,
          finalizeCacheEntry: 1,
          getBlob: 0,
        } satisfies FakeGitHubActionsCacheServerMetrics);
      }

      // Change input back to v0. The large file should be restored from cache.
      {
        await rig.write('input', 'v0');
        server.resetMetrics();

        const exec = rig.exec('npm run a');

        assert.equal((await exec.exit).code, 0);
        assert.equal(cmdA.numInvocations, 2);
        assert.equal(server.metrics, {
          getCacheEntry: 1,
          createCacheEntry: 0,
          putBlobBlock: 0,
          putBlobBlockList: 0,
          finalizeCacheEntry: 0,
          getBlob: 1,
        } satisfies FakeGitHubActionsCacheServerMetrics);
        assert.equal(await rig.read('output'), fileContent);
      }
    },
    {ms: Math.max(DEFAULT_UVU_TIMEOUT, 15_000)},
  ),
);

test.run();
