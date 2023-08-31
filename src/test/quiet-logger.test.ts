/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {timeout} from './util/uvu-timeout.js';
import {WireitTestRig} from './util/test-rig.js';

const test = suite<{rig: WireitTestRig}>();

test.before.each(async (ctx) => {
  try {
    ctx.rig = new WireitTestRig();
    // process.env['SHOW_TEST_OUTPUT'] = 'true';
    // ctx.rig.env['WIREIT_DEBUG_LOGGER'] = 'true';
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
  'CI logger with a dependency chain',
  timeout(async ({rig}) => {
    // a --> b --> c
    rig.env.WIREIT_LOGGER = 'quiet-ci';
    const cmdA = await rig.newCommand();
    const cmdB = await rig.newCommand();
    const cmdC = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
          // wireit scripts can depend on non-wireit scripts.
          c: cmdC.command,
        },
        wireit: {
          a: {
            command: cmdA.command,
            dependencies: ['b'],
          },
          b: {
            command: cmdB.command,
            dependencies: ['c'],
          },
        },
      },
    });
    const exec = rig.exec('npm run a');
    await exec.waitForLog(/0% \[0 \/ 3\] \[1 running\] c/);

    const invC = await cmdC.nextInvocation();
    invC.stdout('c stdout');
    invC.stderr('c stderr');
    invC.exit(0);
    await exec.waitForLog(/33% \[1 \/ 3\] \[1 running\] b/);

    const invB = await cmdB.nextInvocation();
    invB.stdout('b stdout');
    invB.stderr('b stderr');
    invB.exit(0);
    await exec.waitForLog(/67% \[2 \/ 3\] \[1 running\] a/);

    const invA = await cmdA.nextInvocation();
    invA.stdout('a stdout\n');
    // immediately logged, because it's the root command
    await exec.waitForLog(/a stdout/);
    invA.stderr('a stderr\n');
    await exec.waitForLog(/a stderr/);
    invA.exit(0);

    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
    assert.equal(cmdB.numInvocations, 1);
    assert.equal(cmdC.numInvocations, 1);
    assert.match(res.stdout, 'a stdout\n');
    assert.match(res.stdout, /Ran 3 scripts and skipped 0/s);
    assertEndsWith(
      res.stderr.trim(),
      `
  0% [0 / 3] [1 running] c
 33% [1 / 3] [1 running] b
 67% [2 / 3] [1 running] a
a stderr
`.trim(),
    );
  }),
);

function assertEndsWith(actual: string, expected: string) {
  const actualSuffix = actual.slice(-expected.length);
  assert.equal(actualSuffix, expected);
}

test.run();
