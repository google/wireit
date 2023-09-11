/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'uvu/assert';
import * as pathlib from 'path';
import {rigTest} from './util/uvu-timeout.js';
import {sep} from 'path';
import {checkScriptOutput} from './util/check-script-output.js';

import type {Test} from 'uvu';

/**
 * Registers test cases that are common to all cache implementations.
 */
export const registerCommonCacheTests = (
  test: Test,
  cacheMode: 'local' | 'github',
) => {
  test(
    'caches single file',
    rigTest(async ({rig}) => {
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
    }),
  );

  test(
    'caching follows glob patterns',
    rigTest(async ({rig}) => {
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
    }),
  );

  test(
    'caching supports glob re-inclusion',
    rigTest(async ({rig}) => {
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
              output: [
                'output/**',
                '!output/subdir/**',
                'output/subdir/reincluded',
              ],
            },
          },
        },
        input: 'v0',
        'output/subdir/excluded': 'v0',
        'output/subdir/reincluded': 'v0',
      });

      // Initial run with input v0.
      {
        const exec = rig.exec('npm run a');
        const inv = await cmdA.nextInvocation();

        // The excluded file should be un-touched. The reincluded file should
        // have been cleaned.
        assert.equal(await rig.read('output/subdir/excluded'), 'v0');
        assert.not(await rig.exists('output/subdir/reincluded'));

        // Write v0 output.
        await rig.write({'output/subdir/reincluded': 'v0'});

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

        // The excluded file should be un-touched. The reincluded file should
        // have been cleaned.
        assert.equal(await rig.read('output/subdir/excluded'), 'v0');
        assert.not(await rig.exists('output/subdir/reincluded'));

        // Write v1 output.
        await rig.write({'output/subdir/reincluded': 'v1'});

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

        // The re-included output file should be deleted. The other output file
        // should be restored from the v0 cache.
        assert.equal(await rig.read('output/subdir/excluded'), 'v0');
        assert.equal(await rig.read('output/subdir/reincluded'), 'v0');
      }

      // Input changed back to v1. Output should be cached.
      {
        await rig.write({input: 'v1'});
        const exec = rig.exec('npm run a');
        const res = await exec.exit;
        assert.equal(res.code, 0);
        assert.equal(cmdA.numInvocations, 2);

        // The re-included output file should be deleted. The other output file
        // should be restored from the v1 cache.
        assert.equal(await rig.read('output/subdir/excluded'), 'v0');
        assert.equal(await rig.read('output/subdir/reincluded'), 'v1');
      }
    }),
  );

  test(
    'cleans output when restoring from cache even when clean setting is false',
    rigTest(async ({rig}) => {
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
    }),
  );

  test(
    'does not cache script with undefined output',
    rigTest(async ({rig}) => {
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
    }),
  );

  test(
    'caches script with defined but empty output',
    rigTest(async ({rig}) => {
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
    }),
  );

  test(
    'caches symlinks to files without following them',
    rigTest(async ({rig}) => {
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

      await rig.symlink('target', 'symlink', 'file');
      assert.equal(await rig.read('symlink'), 'foo');

      // Initial run with input v0.
      {
        const exec = rig.exec('npm run a');
        const inv = await cmdA.nextInvocation();
        assert.not(await rig.exists('symlink'));
        await rig.symlink('target', 'symlink', 'file');
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
        await rig.symlink('target', 'symlink', 'file');
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

        assert.equal(await rig.readlink('symlink'), 'target');

        assert.equal(await rig.read('symlink'), 'foo');
        // If we restored a real symlink, then changing the target file now will
        // be reflected when we read the symlink. Otherwise, we must have
        // dereferenced the symlink and cached it as a regular file, instead of a
        // symlink.
        await rig.write({target: 'bar'});
        assert.equal(await rig.read('symlink'), 'bar');
      }
    }),
  );

  test(
    'caches symlinks to directories without following them',
    rigTest(async ({rig}) => {
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
        target: 'v0',
      });

      // Initial run with input v0.
      {
        const exec = rig.exec('npm run a');
        const inv = await cmdA.nextInvocation();

        // Target directory should not have been cleaned.
        assert.equal(await rig.read('target'), 'v0');

        // Creates a symlink to the "target" directory.
        await rig.symlink(`..${sep}target`, 'output/symlink', 'dir');

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

        // Target directory should not have been cleaned.
        assert.equal(await rig.read('target'), 'v0');

        // Symlink should have been cleaned.
        assert.not(await rig.exists('symlink'));

        inv.exit(0);
        const res = await exec.exit;
        assert.equal(res.code, 0);
        assert.equal(cmdA.numInvocations, 2);
      }

      // Change input back to v0. Restore from cache.
      {
        // Delete relevant files before running so we can be sure we're looking
        // at the results of a cache restore.
        await rig.delete('output');
        await rig.delete('target');

        await rig.write('input', 'v0');
        const exec = rig.exec('npm run a');
        const res = await exec.exit;
        assert.equal(res.code, 0);
        assert.equal(cmdA.numInvocations, 2);

        // The target directory should not have been restored.
        assert.not(await rig.exists('target'));

        // The symlink file should have been restored, and it should be a
        // symlink to the directory.
        assert.equal(await rig.readlink('output/symlink'), `..${sep}target`);
      }
    }),
  );

  test(
    'does not cache when WIREIT_CACHE=none',
    rigTest(async ({rig}) => {
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
        const exec = rig.exec('npm run a', {env: {WIREIT_CACHE: 'none'}});
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
        const exec = rig.exec('npm run a', {env: {WIREIT_CACHE: 'none'}});
        const inv = await cmdA.nextInvocation();
        await rig.write({output: 'v1'});
        inv.exit(0);
        const res = await exec.exit;
        assert.equal(res.code, 0);
        assert.equal(cmdA.numInvocations, 2);
        assert.equal(await rig.read('output'), 'v1');
      }

      // Input changed back to v0. Output should NOT be cached.
      {
        await rig.write({input: 'v0'});
        const exec = rig.exec('npm run a', {env: {WIREIT_CACHE: 'none'}});
        const inv = await cmdA.nextInvocation();
        await rig.write({output: 'v0'});
        inv.exit(0);
        const res = await exec.exit;
        assert.equal(res.code, 0);
        assert.equal(cmdA.numInvocations, 3);
        assert.equal(await rig.read('output'), 'v0');
      }
    }),
  );

  test(
    'does not cache when CI=true and WIREIT_CACHE is unset',
    rigTest(async ({rig}) => {
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
        const exec = rig.exec('npm run a', {
          env: {CI: 'true', WIREIT_CACHE: undefined},
        });
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
        const exec = rig.exec('npm run a', {
          env: {CI: 'true', WIREIT_CACHE: undefined},
        });
        const inv = await cmdA.nextInvocation();
        await rig.write({output: 'v1'});
        inv.exit(0);
        const res = await exec.exit;
        assert.equal(res.code, 0);
        assert.equal(cmdA.numInvocations, 2);
        assert.equal(await rig.read('output'), 'v1');
      }

      // Input changed back to v0. Output should NOT be cached.
      {
        await rig.write({input: 'v0'});
        const exec = rig.exec('npm run a', {
          env: {CI: 'true', WIREIT_CACHE: undefined},
        });
        const inv = await cmdA.nextInvocation();
        await rig.write({output: 'v0'});
        inv.exit(0);
        const res = await exec.exit;
        assert.equal(res.code, 0);
        assert.equal(cmdA.numInvocations, 3);
        assert.equal(await rig.read('output'), 'v0');
      }
    }),
  );

  test(
    `caches when CI=true and WIREIT_CACHE=${cacheMode}`,
    rigTest(async ({rig}) => {
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
        const exec = rig.exec('npm run a', {
          env: {CI: 'true', WIREIT_CACHE: cacheMode},
        });
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
        const exec = rig.exec('npm run a', {
          env: {CI: 'true', WIREIT_CACHE: cacheMode},
        });
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
        const exec = rig.exec('npm run a', {
          env: {CI: 'true', WIREIT_CACHE: cacheMode},
        });
        const res = await exec.exit;
        assert.equal(res.code, 0);
        assert.equal(cmdA.numInvocations, 2);
        assert.equal(await rig.read('output'), 'v0');
      }

      // Input changed back to v1. Output should be cached.
      {
        await rig.write({input: 'v1'});
        const exec = rig.exec('npm run a', {
          env: {CI: 'true', WIREIT_CACHE: cacheMode},
        });
        const res = await exec.exit;
        assert.equal(res.code, 0);
        assert.equal(cmdA.numInvocations, 2);
        assert.equal(await rig.read('output'), 'v1');
      }
    }),
  );

  test(
    'can cache empty directory',
    rigTest(async ({rig}) => {
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
              output: [
                // An actually empty directory.
                'empty',
                // This directory isn't empty, but the only child it has is
                // excluded by our output globs. So in terms of what we should
                // cache, it is effectively empty.
                //
                // This distinction is important, because an actually empty
                // directory can be naively copied recursively or passed to
                // "tar" as-is, but a directory with an excluded child can't be,
                // because that would incorrectly include the child.
                'with-exclusion',
                '!with-exclusion/excluded',
              ],
            },
          },
        },
      });

      // Initial run.
      {
        await rig.write('input', 'v0');

        const exec = rig.exec('npm run a');
        const inv = await cmdA.nextInvocation();

        await rig.mkdir('empty');
        await rig.mkdir('with-exclusion');
        await rig.touch('with-exclusion/excluded');

        inv.exit(0);
        const res = await exec.exit;
        assert.equal(res.code, 0);
        assert.equal(cmdA.numInvocations, 1);
      }

      // Reset state.
      {
        await rig.write('input', 'v1');
        const exec = rig.exec('npm run a');
        const inv = await cmdA.nextInvocation();
        inv.exit(0);
        const res = await exec.exit;
        assert.equal(res.code, 0);
        assert.equal(cmdA.numInvocations, 2);
      }

      // Restore cache.
      {
        // Ensure we'll be looking at output restored from cache.
        await rig.delete('empty');
        await rig.delete('with-exclusion');

        await rig.write('input', 'v0');
        const exec = rig.exec('npm run a');
        const res = await exec.exit;
        assert.equal(res.code, 0);
        assert.equal(cmdA.numInvocations, 2);

        assert.ok(await rig.isDirectory('empty'));
        assert.ok(await rig.isDirectory('with-exclusion'));
        assert.not(await rig.exists('with-exclusion/excluded'));
      }
    }),
  );

  test(
    'leading slash on output glob is package relative',
    rigTest(async ({rig}) => {
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
              output: ['/output'],
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
    }),
  );

  test(
    'errors if caching output outside of the package',
    rigTest(async ({rig}) => {
      const cmdA = await rig.newCommand();
      await rig.write({
        'foo/package.json': {
          scripts: {
            a: 'wireit',
          },
          wireit: {
            a: {
              command: 'true',
              files: [],
              output: ['../outside'],
              // Turn off cleaning so we get past the similar error that occurs
              // on clean.
              clean: false,
            },
          },
        },
        outside: 'bad',
      });

      const exec = rig.exec('npm run a', {cwd: 'foo'});
      const res = await exec.exit;
      assert.equal(res.code, 1);
      checkScriptOutput(
        res.stderr,
        `
❌ package.json:9:17 Output files must be within the package: ${JSON.stringify(
          pathlib.join(rig.temp, 'outside'),
        )} was outside ${JSON.stringify(pathlib.join(rig.temp, 'foo'))}
          "output": [
                    ~
            "../outside"
    ~~~~~~~~~~~~~~~~~~~~
          ],
    ~~~~~~~`,
      );
      assert.equal(cmdA.numInvocations, 0);

      // The outside file should not have been deleted.
      assert.ok(await rig.exists('outside'));
    }),
  );
};
