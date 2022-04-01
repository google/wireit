/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {timeout} from './util/uvu-timeout.js';
import {WireitTestRig} from './util/test-rig.js';
import * as pathlib from 'path';

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
  'cleans output by default',
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
            output: ['output'],
          },
        },
      },
      output: 'foo',
    });

    // Output should exist before we run the script.
    assert.ok(await rig.exists('output'));

    // Output should be deleted between running the script and executing the
    // command.
    const exec = rig.exec('npm run a');
    const inv = await cmdA.nextInvocation();
    assert.not(await rig.exists('output'));

    inv.exit(0);
    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
  })
);

test(
  'cleans output when clean is true',
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
            output: ['output'],
            clean: true,
          },
        },
      },
      output: 'foo',
    });

    // Output should exist before we run the script.
    assert.ok(await rig.exists('output'));

    // Output should be deleted between running the script and executing the
    // command.
    const exec = rig.exec('npm run a');
    const inv = await cmdA.nextInvocation();
    assert.not(await rig.exists('output'));

    inv.exit(0);
    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
  })
);

test(
  'does not clean output when clean is false',
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
            output: ['output'],
            clean: false,
          },
        },
      },
      output: 'foo',
    });

    const exec = rig.exec('npm run a');
    const inv = await cmdA.nextInvocation();

    // Output should NOT have been deleted because clean was false.
    assert.ok(await rig.exists('output'));

    inv.exit(0);
    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
  })
);

test(
  'cleaning deletes all files matched by glob pattern',
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
            output: ['output/**', '!output/exclude'],
          },
        },
      },
      'output/include': 'foo',
      'output/sub/include': 'foo',
      'output/exclude': 'foo',
    });

    const exec = rig.exec('npm run a');
    const inv = await cmdA.nextInvocation();

    assert.not(await rig.exists('output/include'));
    assert.not(await rig.exists('output/sub/include'));
    assert.ok(await rig.exists('output/exclude'));

    inv.exit(0);
    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
  })
);

test(
  'cleaning deletes directories',
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
            output: ['output/**'],
          },
        },
      },
      'output/subdir/file': 'foo',
    });

    const exec = rig.exec('npm run a');
    const inv = await cmdA.nextInvocation();

    assert.not(await rig.exists('output/subdir/file'));
    assert.not(await rig.exists('output/subdir'));

    inv.exit(0);
    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
  })
);

test(
  'cleaning deletes symlinks but not their targets',
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
            output: ['symlink'],
          },
        },
      },
      'symlink.target': 'foo',
    });
    await rig.symlink('symlink.target', 'symlink');

    const exec = rig.exec('npm run a');
    const inv = await cmdA.nextInvocation();

    // The symlink itself should be deleted, but not the target of the symlink.
    assert.not(await rig.exists('symlink'));
    assert.ok(await rig.exists('symlink.target'));

    inv.exit(0);
    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
  })
);

test(
  'errors if cleaning output outside of the package',
  timeout(async ({rig}) => {
    const cmdA = await rig.newCommand();
    await rig.write({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            output: ['../outside'],
          },
        },
      },
      outside: 'bad',
    });

    const result = rig.exec('npm run a', {cwd: 'foo'});
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [a] Invalid config: refusing to delete output file outside of package: ${pathlib.join(
        rig.temp,
        'outside'
      )}`.trim()
    );
    assert.equal(cmdA.numInvocations, 0);

    // The outside file should not have been deleted.
    assert.ok(await rig.exists('outside'));
  })
);

test.run();
