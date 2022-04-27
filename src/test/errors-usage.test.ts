/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import pathlib from 'path';
import {timeout} from './util/uvu-timeout.js';
import {WireitTestRig} from './util/test-rig.js';

const test = suite<{rig: WireitTestRig}>();

test.before.each(async (ctx) => {
  try {
    ctx.rig = new WireitTestRig();
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

test(
  'invoked directly',
  timeout(async ({rig}) => {
    const result = rig.exec(
      `node ${pathlib.join('..', '..', 'bin', 'wireit.js')}`
    );
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ wireit must be launched with "npm run" or a compatible command.
    More info: Wireit could not identify the script to run.`.trim()
    );
  })
);

test(
  'invoked through npx',
  timeout(async ({rig}) => {
    const result = rig.exec('npx wireit');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ wireit must be launched with "npm run" or a compatible command.
    More info: Launching Wireit with npx is not supported.`.trim()
    );
  })
);

test(
  'negative parallelism',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          main: 'wireit',
        },
        wireit: {
          main: {command: (await rig.newCommand()).command},
        },
      },
    });
    const result = rig.exec('npm run main', {env: {WIREIT_PARALLEL: '-1'}});
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [main] Invalid usage: Expected the WIREIT_PARALLEL env variable to be a positive integer, got "-1"`.trim()
    );
  })
);

test(
  'zero parallelism',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          main: 'wireit',
        },
        wireit: {
          main: {command: (await rig.newCommand()).command},
        },
      },
    });
    const result = rig.exec('npm run main', {env: {WIREIT_PARALLEL: '0'}});
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [main] Invalid usage: Expected the WIREIT_PARALLEL env variable to be a positive integer, got "0"`.trim()
    );
  })
);

test(
  'nonsense parallelism',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          main: 'wireit',
        },
        wireit: {
          main: {command: (await rig.newCommand()).command},
        },
      },
    });
    const result = rig.exec('npm run main', {
      env: {WIREIT_PARALLEL: 'aklsdjflajsdkflj'},
    });
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [main] Invalid usage: Expected the WIREIT_PARALLEL env variable to be a positive integer, got "aklsdjflajsdkflj"`.trim()
    );
  })
);

test(
  'nonsense WIREIT_CACHE',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          main: 'wireit',
        },
        wireit: {
          main: {command: (await rig.newCommand()).command},
        },
      },
    });
    const result = rig.exec('npm run main', {
      env: {WIREIT_CACHE: 'aklsdjflajsdkflj'},
    });
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [main] Invalid usage: Expected the WIREIT_CACHE env variable to be "local", "github", or "none", got "aklsdjflajsdkflj"`.trim()
    );
  })
);

test(
  'github caching without ACTIONS_CACHE_URL',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          main: 'wireit',
        },
        wireit: {
          main: {command: (await rig.newCommand()).command},
        },
      },
    });
    const result = rig.exec('npm run main', {
      env: {
        WIREIT_CACHE: 'github',
        ACTIONS_CACHE_URL: undefined,
        ACTIONS_RUNTIME_TOKEN: 'token',
      },
    });
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [main] Invalid usage: The ACTIONS_CACHE_URL variable was not set, but is required when WIREIT_CACHE=github. Use the google/wireit@setup-github-cache/v1 action to automatically set environment variables.`.trim()
    );
  })
);

test(
  'github caching but ACTIONS_CACHE_URL does not end in slash',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          main: 'wireit',
        },
        wireit: {
          main: {command: (await rig.newCommand()).command},
        },
      },
    });
    const result = rig.exec('npm run main', {
      env: {
        WIREIT_CACHE: 'github',
        ACTIONS_CACHE_URL: 'http://example.com',
        ACTIONS_RUNTIME_TOKEN: 'token',
      },
    });
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [main] Invalid usage: The ACTIONS_CACHE_URL must end in a forward-slash, got "http://example.com".`.trim()
    );
  })
);

test(
  'github caching without ACTIONS_RUNTIME_TOKEN',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          main: 'wireit',
        },
        wireit: {
          main: {command: (await rig.newCommand()).command},
        },
      },
    });
    const result = rig.exec('npm run main', {
      env: {
        WIREIT_CACHE: 'github',
        ACTIONS_CACHE_URL: 'http://example.com/',
        ACTIONS_RUNTIME_TOKEN: undefined,
      },
    });
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [main] Invalid usage: The ACTIONS_RUNTIME_TOKEN variable was not set, but is required when WIREIT_CACHE=github. Use the google/wireit@setup-github-cache/v1 action to automatically set environment variables.`.trim()
    );
  })
);

test.run();
