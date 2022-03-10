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
    assert.match(done.stdout, 'Hello World!');
  })
);

test(
  'rig commands exit as requested',
  timeout(async ({rig}) => {
    // Test 2 different simultaneous commands, one with two simultaneous
    // invocations.
    const cmd1 = await rig.newCommand();
    const cmd2 = await rig.newCommand();

    const res1a = rig.exec(cmd1.command);
    const inv1a = await cmd1.nextInvocation();
    const res1b = rig.exec(cmd1.command);
    const inv1b = await cmd1.nextInvocation();
    const res2a = rig.exec(cmd2.command);
    const inv2a = await cmd2.nextInvocation();

    inv1a.exit(42);
    inv1b.exit(43);
    inv2a.exit(44);

    const done1a = await res1a.exit;
    const done1b = await res1b.exit;
    const done2a = await res2a.exit;

    assert.equal(done1a.code, 42);
    assert.equal(done1b.code, 43);
    assert.equal(done2a.code, 44);
  })
);

test.run();
