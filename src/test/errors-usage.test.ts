/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {test} from 'node:test';
import * as assert from 'node:assert';
import pathlib from 'path';
import {rigTestNode as rigTest} from './util/rig-test.js';
import {NODE_MAJOR_VERSION} from './util/node-version.js';

void test(
  'invoked directly',
  rigTest(async ({rig}) => {
    const result = rig.exec(
      `node ${pathlib.join('..', '..', 'bin', 'wireit.js')}`,
    );
    const done = await result.exit;
    assert.deepStrictEqual(done.code, 1);
    assert.ok(
      done.stderr.includes(
        `
❌ wireit must be launched with "npm run" or a compatible command.
    More info: Wireit could not identify the script to run.`.trim(),
      ),
    );
  }),
);

void test(
  'invoked through npx',
  rigTest(async ({rig}) => {
    const result = rig.exec('npx wireit');
    const done = await result.exit;
    assert.deepStrictEqual(done.code, 1);
    // npx version 6, which ships with Node 14, doesn't set any "npm_"
    // environment variables, so we don't detect it explicitly and show a
    // slightly more general notice.
    const detail =
      NODE_MAJOR_VERSION > 14
        ? 'Launching Wireit with npx is not supported.'
        : 'Wireit could not identify the script to run.';
    assert.ok(
      done.stderr.includes(
        `
❌ wireit must be launched with "npm run" or a compatible command.
    More info: ${detail}`.trim(),
      ),
    );
  }),
);

void test(
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
    assert.deepStrictEqual(done.code, 1);
    assert.ok(
      done.stderr.includes(
        `
❌ [main] Invalid usage: Expected the WIREIT_PARALLEL env variable to be a positive integer, got "-1"`.trim(),
      ),
    );
  }),
);

void test(
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
    assert.deepStrictEqual(done.code, 1);
    assert.ok(
      done.stderr.includes(
        `
❌ [main] Invalid usage: Expected the WIREIT_PARALLEL env variable to be a positive integer, got "0"`.trim(),
      ),
    );
  }),
);

void test(
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
    assert.deepStrictEqual(done.code, 1);
    assert.ok(
      done.stderr.includes(
        `
❌ [main] Invalid usage: Expected the WIREIT_PARALLEL env variable to be a positive integer, got "aklsdjflajsdkflj"`.trim(),
      ),
    );
  }),
);

void test(
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
    assert.deepStrictEqual(done.code, 1);
    assert.ok(
      done.stderr.includes(
        `
❌ [main] Invalid usage: Expected the WIREIT_CACHE env variable to be "local", "github", or "none", got "aklsdjflajsdkflj"`.trim(),
      ),
    );
  }),
);

void test(
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
    assert.deepStrictEqual(done.code, 1);
    assert.ok(
      done.stderr.includes(
        `
❌ [main] Invalid usage: Expected the WIREIT_FAILURES env variable to be "no-new", "continue", or "kill", got "aklsdjflajsdkflj"`.trim(),
      ),
    );
  }),
);

void test(
  'github caching without ACTIONS_RESULTS_URL',
  rigTest(async ({rig}) => {
    const cmd = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          main: 'wireit',
        },
        wireit: {
          main: {
            command: cmd.command,
          },
        },
      },
    });
    const result = rig.exec('npm run main', {
      env: {
        WIREIT_CACHE: 'github',
        ACTIONS_RESULTS_URL: undefined,
        ACTIONS_RUNTIME_TOKEN: 'token',
      },
    });
    (await cmd.nextInvocation()).exit(0);
    const done = await result.exit;
    assert.deepStrictEqual(done.code, 0);
    assert.ok(
      done.stderr.includes(
        `
❌ [main] Invalid usage: The ACTIONS_RESULTS_URL variable was not set, but is required when WIREIT_CACHE=github. Use the google/wireit@setup-github-cache/v1 action to automatically set environment variables.`.trim(),
      ),
    );
  }),
);

void test(
  'github caching but ACTIONS_RESULTS_URL does not end in slash',
  rigTest(async ({rig}) => {
    const cmd = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          main: 'wireit',
        },
        wireit: {
          main: {
            command: cmd.command,
          },
        },
      },
    });
    const result = rig.exec('npm run main', {
      env: {
        WIREIT_CACHE: 'github',
        ACTIONS_RESULTS_URL: 'http://example.com',
        ACTIONS_RUNTIME_TOKEN: 'token',
      },
    });
    (await cmd.nextInvocation()).exit(0);
    const done = await result.exit;
    assert.deepStrictEqual(done.code, 0);
    assert.ok(
      done.stderr.includes(
        `
❌ [main] Invalid usage: The ACTIONS_RESULTS_URL must end in a forward-slash, got "http://example.com".`.trim(),
      ),
    );
  }),
);

void test(
  'github caching without ACTIONS_RUNTIME_TOKEN',
  rigTest(async ({rig}) => {
    const cmd = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          main: 'wireit',
        },
        wireit: {
          main: {
            command: cmd.command,
          },
        },
      },
    });
    const result = rig.exec('npm run main', {
      env: {
        WIREIT_CACHE: 'github',
        ACTIONS_RESULTS_URL: 'http://example.com/',
        ACTIONS_RUNTIME_TOKEN: undefined,
      },
    });
    (await cmd.nextInvocation()).exit(0);
    const done = await result.exit;
    assert.deepStrictEqual(done.code, 0);
    assert.ok(
      done.stderr.includes(
        `
❌ [main] Invalid usage: The ACTIONS_RUNTIME_TOKEN variable was not set, but is required when WIREIT_CACHE=github. Use the google/wireit@setup-github-cache/v1 action to automatically set environment variables.`.trim(),
      ),
    );
  }),
);
