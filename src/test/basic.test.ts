/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {timeout} from './util/uvu-timeout.js';
import {WireitTestRig} from './util/test-rig.js';

const test = suite<{rig: WireitTestRig}>();

test.before.each(async (ctx) => {
  ctx.rig = new WireitTestRig();
  await ctx.rig.setup();
});

test.after.each(async (ctx) => {
  await ctx.rig.cleanup();
});

test(
  'wireit binary executes through npm successfully',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          cmd: 'wireit',
        },
      },
    });
    const result = rig.exec('npm run cmd');
    const done = await result.exit;
    assert.equal(done.code, 0);
  })
);

test(
  'rig commands exit and emit stdout/stderr as requested',
  timeout(async ({rig}) => {
    // Test 2 different simultaneous commands, one with two simultaneous
    // invocations.
    const cmd1 = await rig.newCommand();
    const cmd2 = await rig.newCommand();

    const exec1a = rig.exec(cmd1.command);
    const inv1a = await cmd1.nextInvocation();
    const exec1b = rig.exec(cmd1.command);
    const inv1b = await cmd1.nextInvocation();
    const exec2a = rig.exec(cmd2.command);
    const inv2a = await cmd2.nextInvocation();

    inv1a.stdout('1a stdout');
    inv1a.stderr('1a stderr');
    inv1b.stdout('1b stdout');
    inv1b.stderr('1b stderr');
    inv2a.stdout('2a stdout');
    inv2a.stderr('2a stderr');

    inv1a.exit(42);
    inv1b.exit(43);
    inv2a.exit(44);

    const res1a = await exec1a.exit;
    const res1b = await exec1b.exit;
    const res2a = await exec2a.exit;

    assert.match(res1a.stdout, '1a stdout');
    assert.match(res1a.stderr, '1a stderr');
    assert.match(res1b.stdout, '1b stdout');
    assert.match(res1b.stderr, '1b stderr');
    assert.match(res2a.stdout, '2a stdout');
    assert.match(res2a.stderr, '2a stderr');

    assert.equal(res1a.code, 42);
    assert.equal(res1b.code, 43);
    assert.equal(res2a.code, 44);

    assert.equal(cmd1.numInvocations, 2);
    assert.equal(cmd2.numInvocations, 1);
  })
);

test.run();
