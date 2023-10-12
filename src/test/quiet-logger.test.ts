/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {rigTest} from './util/rig-test.js';

const test = suite<object>();

test(
  'CI logger with a dependency chain',
  rigTest(async ({rig}) => {
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
