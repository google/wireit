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
  'caches single file',
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
            output: ['output'],
          },
        },
      },
      input: 'v0',
    });

    // Initial run with input v0.
    {
      const exec = rig.exec('npm run a');
      const inv = await cmdA.nextInvocation();
      await rig.write({output: 'v0'});
      inv.exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 1);
      assert.equal(await rig.read('output'), 'v0');
    }

    // Input changed to v1. Run again.
    {
      await rig.write({input: 'v1'});
      const exec = rig.exec('npm run a');
      const inv = await cmdA.nextInvocation();
      await rig.write({output: 'v1'});
      inv.exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 2);
      assert.equal(await rig.read('output'), 'v1');
    }

    // Input changed back to v0. Output should be cached.
    {
      await rig.write({input: 'v0'});
      const exec = rig.exec('npm run a');
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 2);
      assert.equal(await rig.read('output'), 'v0');
    }

    // Input changed back to v1. Output should be cached.
    {
      await rig.write({input: 'v1'});
      const exec = rig.exec('npm run a');
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 2);
      assert.equal(await rig.read('output'), 'v1');
    }
  })
);

test(
  'caching follows glob patterns',
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
            output: ['output/**', '!output/excluded/**'],
          },
        },
      },
      input: 'v0',
      'output/excluded/foo': 'excluded',
    });

    // Initial run with input v0.
    {
      const exec = rig.exec('npm run a');
      const inv = await cmdA.nextInvocation();

      await rig.write({'output/0/a': 'v0'});
      await rig.write({'output/0/b': 'v0'});
      await rig.write({'output/0/c/d/e': 'v0'});
      assert.equal(await rig.read('output/excluded/foo'), 'excluded');

      inv.exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 1);
    }

    // Input changed to v1. Run again.
    {
      await rig.write({input: 'v1'});
      const exec = rig.exec('npm run a');
      const inv = await cmdA.nextInvocation();

      // Previous output should be deleted.
      assert.not(await rig.exists('output/0/a'));
      assert.not(await rig.exists('output/0/b'));
      assert.not(await rig.exists('output/0/c/d/e'));
      assert.equal(await rig.read('output/excluded/foo'), 'excluded');

      await rig.write({'output/1/a': 'v1'});
      await rig.write({'output/1/b': 'v1'});
      await rig.write({'output/1/c/d/e': 'v1'});

      inv.exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 2);
    }

    // Input changed back to v0. Output should be cached.
    {
      await rig.write({input: 'v0'});
      const exec = rig.exec('npm run a');
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 2);

      assert.not(await rig.exists('output/1/a'));
      assert.not(await rig.exists('output/1/b'));
      assert.not(await rig.exists('output/1/c/d/e'));
      assert.equal(await rig.read('output/0/a'), 'v0');
      assert.equal(await rig.read('output/0/b'), 'v0');
      assert.equal(await rig.read('output/0/c/d/e'), 'v0');
      assert.equal(await rig.read('output/excluded/foo'), 'excluded');
    }

    // Input changed back to v1. Output should be cached.
    {
      await rig.write({input: 'v1'});
      const exec = rig.exec('npm run a');
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 2);

      assert.not(await rig.exists('output/0/a'));
      assert.not(await rig.exists('output/0/b'));
      assert.not(await rig.exists('output/0/c/d/e'));
      assert.equal(await rig.read('output/1/a'), 'v1');
      assert.equal(await rig.read('output/1/b'), 'v1');
      assert.equal(await rig.read('output/1/c/d/e'), 'v1');
      assert.equal(await rig.read('output/excluded/foo'), 'excluded');
    }
  })
);

test(
  'cleans output when restoring from cache even when clean setting is false',
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
            output: ['output/**'],
            clean: false,
          },
        },
      },
      input: 'v0',
    });

    // Initial run with input v0.
    {
      const exec = rig.exec('npm run a');
      const inv = await cmdA.nextInvocation();
      await rig.write({'output/both': 'v0'});
      await rig.write({'output/only-v0': 'v0'});
      inv.exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 1);
      assert.equal(await rig.read('output/both'), 'v0');
      assert.equal(await rig.read('output/only-v0'), 'v0');
      assert.not(await rig.exists('output/only-v1'));
    }

    // Input changed to v1. Run again.
    {
      await rig.write({input: 'v1'});
      const exec = rig.exec('npm run a');
      const inv = await cmdA.nextInvocation();
      await rig.write({'output/both': 'v1'});
      await rig.write({'output/only-v1': 'v1'});
      // "clean" should be used for scripts that clean up stale output in an
      // incremental build, so we are simulating that here.
      await rig.delete('output/only-v0');
      inv.exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 2);
      assert.equal(await rig.read('output/both'), 'v1');
      assert.not(await rig.exists('output/only-v0'));
      assert.equal(await rig.read('output/only-v1'), 'v1');
    }

    // Input changed back to v0. Output should be cached, and the only-v1 file
    // should be deleted, even though clean is set to false.
    {
      await rig.write({input: 'v0'});
      const exec = rig.exec('npm run a');
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 2);
      assert.equal(await rig.read('output/both'), 'v0');
      assert.equal(await rig.read('output/only-v0'), 'v0');
      assert.not(await rig.exists('output/only-v1'));
    }

    // Input changed back to v1. Output should be cached, and the only-v0 file
    // should be deleted, even though clean is set to false.
    {
      await rig.write({input: 'v1'});
      const exec = rig.exec('npm run a');
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 2);
      assert.equal(await rig.read('output/both'), 'v1');
      assert.not(await rig.exists('output/only-v0'));
      assert.equal(await rig.read('output/only-v1'), 'v1');
    }
  })
);

test(
  'does not cache script with undefined output',
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

    // Initial run with input v0.
    {
      const exec = rig.exec('npm run a');
      const inv = await cmdA.nextInvocation();
      inv.exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 1);
    }

    // Input changed to v1. Run again.
    {
      await rig.write({input: 'v1'});
      const exec = rig.exec('npm run a');
      const inv = await cmdA.nextInvocation();
      inv.exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 2);
    }

    // Input changed back to v0. Caching not possible becuase output was
    // undefined. Run again.
    {
      await rig.write({input: 'v0'});
      const exec = rig.exec('npm run a');
      const inv = await cmdA.nextInvocation();
      inv.exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 3);
    }
  })
);

test(
  'caches script with defined but empty output',
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
            output: [],
          },
        },
      },
      input: 'v0',
    });

    // Initial run with input v0.
    {
      const exec = rig.exec('npm run a');
      const inv = await cmdA.nextInvocation();
      inv.exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 1);
    }

    // Input changed to v1. Run again.
    {
      await rig.write({input: 'v1'});
      const exec = rig.exec('npm run a');
      const inv = await cmdA.nextInvocation();
      inv.exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 2);
    }

    // Input changed back to v0. Script should be cached, even though output is
    // empty.
    {
      await rig.write({input: 'v0'});
      const exec = rig.exec('npm run a');
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 2);
    }
  })
);

test(
  'caches symlinks without following them',
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
            output: ['symlink'],
          },
        },
      },
      input: 'v0',
      target: 'foo',
    });

    await rig.symlink('target', 'symlink');
    assert.equal(await rig.read('symlink'), 'foo');

    // Initial run with input v0.
    {
      const exec = rig.exec('npm run a');
      const inv = await cmdA.nextInvocation();
      assert.not(await rig.exists('symlink'));
      await rig.symlink('target', 'symlink');
      inv.exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 1);
    }

    // Change input to v1. Run again.
    {
      await rig.write({input: 'v1'});
      const exec = rig.exec('npm run a');
      const inv = await cmdA.nextInvocation();
      assert.not(await rig.exists('symlink'));
      await rig.symlink('target', 'symlink');
      inv.exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 2);
    }

    // Change input back to v0. Restored from cache.
    {
      await rig.write({input: 'v0'});
      const exec = rig.exec('npm run a');
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 2);

      assert.equal(await rig.read('symlink'), 'foo');
      // If we restored a real symlink, then changing the target file now will
      // be reflected when we read the symlink. Otherwise, we must have
      // dereferenced the symlink and cached it as a regular file, instead of a
      // symlink.
      await rig.write({target: 'bar'});
      assert.equal(await rig.read('symlink'), 'bar');
    }
  })
);

test(
  'replays stdout when restored from local cache',
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
            output: ['output'],
          },
        },
      },
    });

    // Initial run with input v0. Writes some stdout.
    {
      await rig.write({input: 'v0'});
      const exec = rig.exec('npm run a');
      const invA = await cmdA.nextInvocation();
      invA.stdout('stdout v0');
      invA.exit(0);
      const res = await exec.exit;
      assert.match(res.stdout, 'stdout v0');
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 1);
    }

    // Input changed to v1. Run again. Writes different stdout.
    {
      await rig.write({input: 'v1'});
      const exec = rig.exec('npm run a');
      const invA = await cmdA.nextInvocation();
      invA.stdout('stdout v1');
      invA.exit(0);
      const res = await exec.exit;
      assert.match(res.stdout, 'stdout v1');
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 2);
    }

    // Input reverts to v0. Stdout should be replayed from cache.
    {
      await rig.write({input: 'v0'});
      const exec = rig.exec('npm run a');
      const res = await exec.exit;
      assert.match(res.stdout, 'stdout v0');
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 2);
    }
  })
);

test(
  'replays stderr when restored from local cache',
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
            output: ['output'],
          },
        },
      },
    });

    // Initial run with input v0. Writes some stderr.
    {
      await rig.write({input: 'v0'});
      const exec = rig.exec('npm run a');
      const invA = await cmdA.nextInvocation();
      invA.stderr('stderr v0');
      invA.exit(0);
      const res = await exec.exit;
      assert.match(res.stderr, 'stderr v0');
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 1);
    }

    // Input changed to v1. Run again. Writes different stderr.
    {
      await rig.write({input: 'v1'});
      const exec = rig.exec('npm run a');
      const invA = await cmdA.nextInvocation();
      invA.stderr('stderr v1');
      invA.exit(0);
      const res = await exec.exit;
      assert.match(res.stderr, 'stderr v1');
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 2);
    }

    // Input reverts to v0. Stdout should be replayed from cache.
    {
      await rig.write({input: 'v0'});
      const exec = rig.exec('npm run a');
      const res = await exec.exit;
      assert.match(res.stderr, 'stderr v0');
      assert.equal(res.code, 0);
      assert.equal(cmdA.numInvocations, 2);
    }
  })
);

test.run();
