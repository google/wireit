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
import {removeAciiColors} from './util/colors.js';

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
  'cleaning supports glob re-inclusion',
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
            output: [
              'output/**',
              '!output/subdir/**',
              'output/subdir/reincluded',
            ],
          },
        },
      },
      'output/subdir/excluded': 'v0',
      'output/subdir/reincluded': 'v0',
    });

    const exec = rig.exec('npm run a');
    const inv = await cmdA.nextInvocation();

    assert.ok(await rig.exists('output/subdir/excluded'));
    assert.not(await rig.exists('output/subdir/reincluded'));

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
    await rig.symlink('symlink.target', 'symlink', 'file');

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
      removeAciiColors(done.stderr.trim()),
      `
❌ package.json:8:17 refusing to delete output file outside of package: ${pathlib.join(
        rig.temp,
        'outside'
      )}
          "output": [
                    ~
            "../outside"
    ~~~~~~~~~~~~~~~~~~~~
          ]
    ~~~~~~~`.trim()
    );
    assert.equal(cmdA.numInvocations, 0);

    // The outside file should not have been deleted.
    assert.ok(await rig.exists('outside'));
  })
);

test(
  '"if-file-deleted" cleans only when input file deleted',
  timeout(async ({rig}) => {
    const cmdA = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            files: ['input/**'],
            output: ['output/**'],
            clean: 'if-file-deleted',
            // Include a dependency on a script with no input files to cover an
            // edge case that was broken in an earlier implementation.
            //
            // We use the ".wireit/<script>/state" file to find out which input
            // files were present in the previous run, so that we can compare
            // them to the current input files. However, in an earlier
            // implementation we did not save a "state" file for scripts with a
            // dependency that have no input files (because that makes the
            // script "uncacheable").
            dependencies: ['b'],
          },
          b: {
            command: 'true',
          },
        },
      },
    });

    // Initial run creates output A.
    {
      await rig.write({'input/a': 'v0'});

      const exec = rig.exec('npm run a');
      const inv = await cmdA.nextInvocation();

      // No outputs have been written yet.
      assert.not(await rig.exists('output/a'));
      assert.not(await rig.exists('output/b'));
      assert.not(await rig.exists('output/c'));

      // Write output A.
      await rig.write({'output/a': 'v0'});

      inv.exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
    }

    // Add new input file. Don't clean. Creates output/b.
    {
      await rig.write({'input/b': 'v0'});

      const exec = rig.exec('npm run a');
      const inv = await cmdA.nextInvocation();

      // Output A should still exist.
      assert.equal(await rig.read('output/a'), 'v0');
      assert.not(await rig.exists('output/b'));
      assert.not(await rig.exists('output/c'));

      // Write outputs A and B.
      await rig.write({'output/a': 'v1'});
      await rig.write({'output/b': 'v1'});

      inv.exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
    }

    // Modify input file. Don't clean.
    {
      await rig.write({'input/a': 'v1'});

      const exec = rig.exec('npm run a');
      const inv = await cmdA.nextInvocation();

      // Outputs A and B should still exist.
      assert.equal(await rig.read('output/a'), 'v1');
      assert.equal(await rig.read('output/b'), 'v1');
      assert.not(await rig.exists('output/c'));

      // Write outputs A and B
      await rig.write({'output/a': 'v2'});
      await rig.write({'output/b': 'v2'});

      inv.exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 3);
    }

    // Delete input file. Clean. (This covers the case where the number of input
    // files is lower).
    {
      await rig.delete('input/a');

      const exec = rig.exec('npm run a');
      const inv = await cmdA.nextInvocation();

      // Outputs A and B should have been cleaned.
      assert.not(await rig.exists('output/a'));
      assert.not(await rig.exists('output/b'));
      assert.not(await rig.exists('output/c'));

      // Write output B.
      await rig.write({'output/b': 'v3'});

      inv.exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
    }

    // Delete an input file, and also add an input file. Clean. (This covers the
    // case where the number of input files are the same, but they are
    // different.)
    {
      await rig.delete('input/b');
      await rig.write({'input/c': 'v0'});

      const exec = rig.exec('npm run a');
      const inv = await cmdA.nextInvocation();

      // Output B should have been cleaned.
      assert.not(await rig.exists('output/a'));
      assert.not(await rig.exists('output/b'));
      assert.not(await rig.exists('output/c'));

      // Write output C.
      await rig.write({'output/c': 'v0'});

      inv.exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
    }

    assert.equal(cmdA.numInvocations, 5);
  })
);

test(
  'directories are not deleted unless empty',
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
            output: ['output', '!output/excluded'],
          },
        },
      },
      'output/included': '',
      'output/excluded': '',
    });

    {
      const exec = rig.exec('npm run a');
      const inv = await cmdA.nextInvocation();

      // The included file should have been deleted.
      assert.not(await rig.exists('output/included'));

      // The output directory should not have been deleted, even though it was
      // matched, because the excluded file still exists, so it's not empty.
      assert.ok(await rig.exists('output'));

      // The excluded should not have been deleted.
      assert.ok(await rig.exists('output/excluded'));

      inv.exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 1);
    }

    {
      // Restore the included file and delete the excluded file.
      await rig.touch('output/included');
      await rig.delete('output/excluded');

      const exec = rig.exec('npm run a');
      const inv = await cmdA.nextInvocation();

      // The included file should have been deleted.
      assert.not(await rig.exists('output/included'));

      // The output directory is now empty, so it should have been deleted.
      assert.not(await rig.exists('output'));

      // The excluded file didn't exist to begin with.
      assert.not(await rig.exists('output/excluded'));

      inv.exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 2);
    }
  })
);

test(
  'leading slash on output glob is package relative',
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
            output: ['/output'],
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

test.run();
