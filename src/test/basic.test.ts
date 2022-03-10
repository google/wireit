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

test.run();
