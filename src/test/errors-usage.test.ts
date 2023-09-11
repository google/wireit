/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import pathlib from 'path';
import {rigTest} from './util/uvu-timeout.js';
import {NODE_MAJOR_VERSION} from './util/node-version.js';

const test = suite();

test(
  'invoked directly',
  rigTest(async ({rig}) => {
    const result = rig.exec(
      `node ${pathlib.join('..', '..', 'bin', 'wireit.js')}`,
    );
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.match(
      done.stderr,
      `
❌ wireit must be launched with "npm run" or a compatible command.
    More info: Wireit could not identify the script to run.`.trim(),
    );
  }),
);

test(
  'invoked through npx',
  rigTest(async ({rig}) => {
    const result = rig.exec('npx wireit');
    const done = await result.exit;
    assert.equal(done.code, 1);
    // npx version 6, which ships with Node 14, doesn't set any "npm_"
    // environment variables, so we don't detect it explicitly and show a
    // slightly more general notice.
    const detail =
      NODE_MAJOR_VERSION > 14
        ? 'Launching Wireit with npx is not supported.'
        : 'Wireit could not identify the script to run.';
    assert.match(
      done.stderr,
      `
❌ wireit must be launched with "npm run" or a compatible command.
    More info: ${detail}`.trim(),
    );
  }),
);

test(
  'negative parallelism',
  rigTest(async ({rig}) => {
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
    assert.match(
      done.stderr,
      `
❌ [main] Invalid usage: Expected the WIREIT_PARALLEL env variable to be a positive integer, got "-1"`.trim(),
    );
  }),
);

test(
  'zero parallelism',
  rigTest(async ({rig}) => {
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
    assert.match(
      done.stderr,
      `
❌ [main] Invalid usage: Expected the WIREIT_PARALLEL env variable to be a positive integer, got "0"`.trim(),
    );
  }),
);

test(
  'nonsense parallelism',
  rigTest(async ({rig}) => {
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
    assert.match(
      done.stderr,
      `
❌ [main] Invalid usage: Expected the WIREIT_PARALLEL env variable to be a positive integer, got "aklsdjflajsdkflj"`.trim(),
    );
  }),
);

test(
  'nonsense WIREIT_CACHE',
  rigTest(async ({rig}) => {
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
    assert.match(
      done.stderr,
      `
❌ [main] Invalid usage: Expected the WIREIT_CACHE env variable to be "local", "github", or "none", got "aklsdjflajsdkflj"`.trim(),
    );
  }),
);

test(
  'nonsense WIREIT_FAILURES',
  rigTest(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          main: 'wireit',
        },
        wireit: {
          main: {command: 'true'},
        },
      },
    });
    const result = rig.exec('npm run main', {
      env: {WIREIT_FAILURES: 'aklsdjflajsdkflj'},
    });
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.match(
      done.stderr,
      `
❌ [main] Invalid usage: Expected the WIREIT_FAILURES env variable to be "no-new", "continue", or "kill", got "aklsdjflajsdkflj"`.trim(),
    );
  }),
);

test(
  'github caching without ACTIONS_CACHE_URL',
  rigTest(async ({rig}) => {
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
    assert.match(
      done.stderr,
      `
❌ [main] Invalid usage: The ACTIONS_CACHE_URL variable was not set, but is required when WIREIT_CACHE=github. Use the google/wireit@setup-github-cache/v1 action to automatically set environment variables.`.trim(),
    );
  }),
);

test(
  'github caching but ACTIONS_CACHE_URL does not end in slash',
  rigTest(async ({rig}) => {
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
    assert.match(
      done.stderr,
      `
❌ [main] Invalid usage: The ACTIONS_CACHE_URL must end in a forward-slash, got "http://example.com".`.trim(),
    );
  }),
);

test(
  'github caching without ACTIONS_RUNTIME_TOKEN',
  rigTest(async ({rig}) => {
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
    assert.match(
      done.stderr,
      `
❌ [main] Invalid usage: The ACTIONS_RUNTIME_TOKEN variable was not set, but is required when WIREIT_CACHE=github. Use the google/wireit@setup-github-cache/v1 action to automatically set environment variables.`.trim(),
    );
  }),
);

test.run();
