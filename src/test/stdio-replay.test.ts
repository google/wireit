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
  'replays stdout when script is fresh',
  timeout(async ({rig}) => {
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
          },
        },
      },
    });

    // Initial run. Script writes some stdout.
    {
      const exec = rig.exec('npm run a');
      const invA = await cmdA.nextInvocation();
      invA.stdout('this is my stdout');
      invA.exit(0);
      const res = await exec.exit;
      assert.match(res.stdout, 'this is my stdout');
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 1);
    }

    // No input changed, so script is fresh, and we replay saved stdout.
    {
      const exec = rig.exec('npm run a');
      const res = await exec.exit;
      assert.match(res.stdout, 'this is my stdout');
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 1);
    }
  })
);

test(
  'replays stderr when script is fresh',
  timeout(async ({rig}) => {
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
          },
        },
      },
    });

    // Initial run. Script writes some stderr.
    {
      const exec = rig.exec('npm run a');
      const invA = await cmdA.nextInvocation();
      invA.stderr('this is my stderr');
      invA.exit(0);
      const res = await exec.exit;
      assert.match(res.stderr, 'this is my stderr');
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 1);
    }

    // No input changed, so script is fresh, and we replay saved stderr.
    {
      const exec = rig.exec('npm run a');
      const res = await exec.exit;
      assert.match(res.stderr, 'this is my stderr');
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 1);
    }
  })
);

test(
  'deletes stdout and stderr across runs',
  timeout(async ({rig}) => {
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
          },
        },
      },
      input: 'v0',
    });

    // Initial run. Script writes some stdout and stderr which gets saved to
    // replay files.
    {
      const exec = rig.exec('npm run a');
      const invA = await cmdA.nextInvocation();
      invA.stdout('v0 stdout');
      invA.stderr('v0 stderr');
      invA.exit(0);
      const res = await exec.exit;
      assert.match(res.stdout, 'v0 stdout');
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 1);
    }

    // Input did not change, so script should be fresh and we should replay the
    // saved stdout and stderr.
    {
      const exec = rig.exec('npm run a');
      const res = await exec.exit;
      assert.match(res.stdout, 'v0 stdout');
      assert.match(res.stderr, 'v0 stderr');
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 1);
    }

    // Change input, so script runs again. This time, the script doesn't write
    // any stdout or stderr, but we still delete the previous stdout and stderr
    // replays.
    {
      await rig.write({input: 'v1'});
      const exec = rig.exec('npm run a');
      const invA = await cmdA.nextInvocation();
      invA.exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 2);
    }

    // Input did not change, so script should be fresh. There should be no
    // stdout or stderr.
    {
      const exec = rig.exec('npm run a');
      const res = await exec.exit;
      assert.not.match(res.stdout, 'v0 stdout');
      assert.not.match(res.stderr, 'v0 stderr');
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 2);
    }
  })
);

test.run();
