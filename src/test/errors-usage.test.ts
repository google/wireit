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
  ctx.rig = new WireitTestRig();
  await ctx.rig.setup();
});

test.after.each(async (ctx) => {
  await ctx.rig.cleanup();
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
❌ wireit must be launched with "npm run"`.trim()
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
❌ wireit must be launched with "npm run"`.trim()
    );
  })
);

test.run();
