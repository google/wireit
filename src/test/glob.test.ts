/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import * as assert from 'uvu/assert';
import {suite} from 'uvu';
import {glob} from '../util/glob.js';
import {FilesystemTestRig} from './util/filesystem-test-rig.js';

interface Symlink {
  /** Where the symlink file points to. */
  target: string;
  /** The symlink file. */
  path: string;
  /** The type of symlink on Windows. */
  windowsType: 'file' | 'dir' | 'junction';
}

interface TestCase {
  files: Array<string | Symlink>;
  patterns: string[];
  expected: string[] | 'ERROR';
  cwd?: string;
  absolute?: boolean;
  followSymlinks?: boolean;
  includeDirectories?: boolean;
  expandDirectories?: boolean;
  rerootToCwd?: boolean;
  throwIfOutsideCwd?: boolean;
}

const test = suite<{
  rig: FilesystemTestRig;
  check: (data: TestCase) => Promise<void>;
}>();

test.before.each(async (ctx) => {
  try {
    const rig = (ctx.rig = new FilesystemTestRig());
    await rig.setup();

    ctx.check = async ({
      files,
      patterns,
      expected,
      cwd = '.',
      absolute = false,
      followSymlinks = true,
      includeDirectories = false,
      expandDirectories = false,
      rerootToCwd = false,
      throwIfOutsideCwd = false,
    }: TestCase): Promise<void> => {
      for (const file of files) {
        if (typeof file === 'string') {
          if (file.endsWith('/')) {
            // directory
            await rig.mkdir(file);
          } else {
            // file
            await rig.touch(file);
          }
        } else {
          // symlink
          await rig.symlink(file.target, file.path, file.windowsType);
        }
      }

      if (pathlib.sep === '\\' && expected !== 'ERROR') {
        // On Windows we expect to get results back with "\" as the separator.
        expected = expected.map((path) => path.replace(/\//g, '\\'));
      }

      let actual, error;
      try {
        actual = await glob(patterns, {
          cwd: rig.resolve(cwd),
          absolute,
          followSymlinks,
          includeDirectories,
          expandDirectories,
          rerootToCwd,
          throwIfOutsideCwd,
        });
      } catch (e) {
        error = e;
      }
      if (expected === 'ERROR') {
        if (error === undefined) {
          assert.unreachable('Expected an error');
        }
      } else if (error !== undefined) {
        throw error;
      } else if (actual === undefined) {
        throw new Error('Actual was undefined');
      } else {
        const actualPaths = actual.map((file) => file.path);
        assert.equal(actualPaths.sort(), expected.sort());
      }
    };
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

test('empty patterns', ({check}) =>
  check({
    files: ['foo'],
    patterns: [],
    expected: [],
  }));

test('explicit file', ({check}) =>
  check({
    files: ['foo'],
    patterns: ['foo'],
    expected: ['foo'],
  }));

test('explicit file that does not exist', ({check}) =>
  check({
    files: [],
    patterns: ['foo'],
    expected: [],
  }));

test('* star', ({check}) =>
  check({
    files: ['foo', 'bar'],
    patterns: ['*'],
    expected: ['foo', 'bar'],
  }));

test('* star with ! negation', ({check}) =>
  check({
    files: ['foo', 'bar', 'baz'],
    patterns: ['*', '!bar'],
    expected: ['foo', 'baz'],
  }));

test('explicit .dotfile', ({check}) =>
  check({
    files: ['.foo'],
    patterns: ['.foo'],
    expected: ['.foo'],
  }));

test('* star matches .dotfiles', ({check}) =>
  check({
    files: ['.foo'],
    patterns: ['*'],
    expected: ['.foo'],
  }));

test('{} groups', ({check}) =>
  check({
    files: ['foo', 'bar', 'baz'],
    patterns: ['{foo,baz}'],
    expected: ['foo', 'baz'],
  }));

test('matches explicit symlink', ({check}) =>
  check({
    files: ['target', {target: 'target', path: 'symlink', windowsType: 'file'}],
    patterns: ['symlink'],
    expected: ['symlink'],
  }));

test('absolute', ({check, rig}) =>
  check({
    files: ['foo'],
    patterns: ['foo'],
    expected: [rig.resolve('foo')],
    absolute: true,
  }));

test('explicit directory excluded when includeDirectories=false', ({check}) =>
  check({
    files: ['foo/'],
    patterns: ['foo'],
    expected: [],
  }));

test('explicit directory included when includeDirectories=true', ({check}) =>
  check({
    files: ['foo/'],
    patterns: ['foo'],
    expected: ['foo'],
    includeDirectories: true,
  }));

test('* star excludes directory when includeDirectories=false', ({check}) =>
  check({
    files: ['foo/'],
    patterns: ['*'],
    expected: [],
  }));

test('* star includes directory when includeDirectories=true', ({check}) =>
  check({
    files: ['foo/'],
    patterns: ['*'],
    expected: ['foo'],
    includeDirectories: true,
  }));

test('includeDirectories=false + expandDirectories=false', ({check}) =>
  check({
    files: ['1', '2', 'foo/1', 'foo/2', 'foo/bar/1', 'foo/bar/2', 'foo/baz/'],
    patterns: ['foo'],
    expected: [],
    includeDirectories: false,
    expandDirectories: false,
  }));

test('includeDirectories=true + expandDirectories=false', ({check}) =>
  check({
    files: ['1', '2', 'foo/1', 'foo/2', 'foo/bar/1', 'foo/bar/2', 'foo/baz/'],
    patterns: ['foo'],
    expected: ['foo'],
    includeDirectories: true,
    expandDirectories: false,
  }));

test('includeDirectories=false + expandDirectories=true', ({check}) =>
  check({
    files: ['1', '2', 'foo/1', 'foo/2', 'foo/bar/1', 'foo/bar/2', 'foo/baz/'],
    patterns: ['foo'],
    expected: ['foo/1', 'foo/2', 'foo/bar/1', 'foo/bar/2'],
    includeDirectories: false,
    expandDirectories: true,
  }));

test('includeDirectories=true + expandDirectories=true', ({check}) =>
  check({
    files: ['1', '2', 'foo/1', 'foo/2', 'foo/bar/1', 'foo/bar/2', 'foo/baz/'],
    patterns: ['foo'],
    expected: [
      'foo',
      'foo/1',
      'foo/2',
      'foo/bar',
      'foo/bar/1',
      'foo/bar/2',
      'foo/baz',
    ],
    includeDirectories: true,
    expandDirectories: true,
  }));

test('includeDirectories=true + expandDirectories=true + recursive !exclusion', ({
  check,
}) =>
  check({
    files: ['1', '2', 'foo/1', 'foo/2', 'foo/bar/1', 'foo/bar/2', 'foo/baz/'],
    patterns: [
      'foo',
      // This exclusion pattern needs to match recursively too. We don't just
      // exclude the "foo/bar" directory, we also exclude its recursive
      // children.
      '!foo/bar',
    ],
    expected: ['foo', 'foo/1', 'foo/2', 'foo/baz'],
    includeDirectories: true,
    expandDirectories: true,
  }));

test('. matches current directory with includeDirectories=true', ({check}) =>
  check({
    files: ['1', '2', 'foo/1', 'foo/2', 'foo/bar/1', 'foo/bar/2', 'foo/baz/'],
    patterns: ['.'],
    expected: ['.'],
    includeDirectories: true,
  }));

test('. matches current directory with expandDirectories=true', ({check}) =>
  check({
    files: ['1', '2', 'foo/1', 'foo/2', 'foo/bar/1', 'foo/bar/2', 'foo/baz/'],
    patterns: ['.'],
    expected: ['1', '2', 'foo/1', 'foo/2', 'foo/bar/1', 'foo/bar/2'],
    expandDirectories: true,
  }));

test('{} groups with expand directories', ({check}) =>
  check({
    files: ['1', '2', 'foo/1', 'foo/2', 'foo/bar/1', 'foo/bar/2', 'foo/baz/'],
    patterns: ['{foo,baz}'],
    expected: ['foo/1', 'foo/2', 'foo/bar/1', 'foo/bar/2'],
    expandDirectories: true,
  }));

test('empty pattern throws', ({check}) =>
  check({
    files: ['foo', 'bar'],
    patterns: [''],
    expected: 'ERROR',
  }));

test('empty pattern throws with expandDirectories=true', ({check}) =>
  check({
    files: ['foo', 'bar'],
    patterns: [''],
    expected: 'ERROR',
    expandDirectories: true,
  }));

test('whitespace pattern throws', ({check}) =>
  check({
    files: ['foo', 'bar'],
    patterns: [' '],
    expected: 'ERROR',
  }));

test('whitespace pattern throws with expandDirectories=true', ({check}) =>
  check({
    files: ['foo', 'bar'],
    patterns: [' '],
    expected: 'ERROR',
    expandDirectories: true,
  }));

test('re-inclusion of file', ({check}) =>
  check({
    files: ['foo'],
    patterns: ['!foo', 'foo'],
    expected: ['foo'],
  }));

test('re-inclusion of directory', ({check}) =>
  check({
    files: ['foo/'],
    patterns: ['!foo', 'foo'],
    expected: ['foo'],
    includeDirectories: true,
  }));

test('re-inclusion of file into directory', ({check}) =>
  check({
    files: ['foo/1', 'foo/bar/1', 'foo/bar/baz', 'foo/qux'],
    patterns: ['foo/**', '!foo/bar/**', 'foo/bar/baz', '!foo/qux'],
    expected: ['foo/1', 'foo/bar/baz'],
  }));

test('re-inclusion of file into directory with expandDirectories=true', ({
  check,
}) =>
  check({
    files: ['foo/1', 'foo/bar/1', 'foo/bar/baz', 'foo/qux'],
    patterns: ['foo', '!foo/bar', 'foo/bar/baz', '!foo/qux'],
    expected: ['foo/1', 'foo/bar/baz'],
    expandDirectories: true,
  }));

test('re-inclusion of directory into directory with expandDirectories=true', ({
  check,
}) =>
  check({
    files: ['foo/1', 'foo/bar/1', 'foo/bar/baz/1'],
    patterns: ['foo', '!foo/bar', 'foo/bar/baz'],
    expected: ['foo/1', 'foo/bar/baz/1'],
    expandDirectories: true,
  }));

test('walks through symlinked directories when followSymlinks=true', ({
  check,
}) =>
  check({
    files: [
      'target/foo',
      {target: 'target', path: 'symlink', windowsType: 'dir'},
    ],
    patterns: ['**'],
    expected: ['target', 'target/foo', 'symlink', 'symlink/foo'],
    includeDirectories: true,
    followSymlinks: true,
  }));

test('does not walk through symlinked directories when followSymlinks=false', ({
  check,
}) =>
  check({
    files: [
      'target/foo',
      {target: 'target', path: 'symlink', windowsType: 'dir'},
    ],
    patterns: ['**'],
    expected: ['target', 'target/foo', 'symlink'],
    includeDirectories: true,
    followSymlinks: false,
  }));

test('dirent tags files', async ({rig}) => {
  await rig.touch('foo');
  const actual = await glob(['foo'], {
    cwd: rig.temp,
    absolute: false,
    followSymlinks: true,
    includeDirectories: true,
    expandDirectories: false,
    rerootToCwd: false,
    throwIfOutsideCwd: false,
  });
  assert.equal(actual.length, 1);
  assert.equal(actual[0].path, 'foo');
  assert.ok(actual[0].dirent.isFile());
  assert.not(actual[0].dirent.isDirectory());
  assert.not(actual[0].dirent.isSymbolicLink());
});

test('dirent tags directories', async ({rig}) => {
  await rig.mkdir('foo');
  const actual = await glob(['foo'], {
    cwd: rig.temp,
    absolute: false,
    followSymlinks: true,
    includeDirectories: true,
    expandDirectories: false,
    rerootToCwd: false,
    throwIfOutsideCwd: false,
  });
  assert.equal(actual.length, 1);
  assert.equal(actual[0].path, 'foo');
  assert.not(actual[0].dirent.isFile());
  assert.ok(actual[0].dirent.isDirectory());
  assert.not(actual[0].dirent.isSymbolicLink());
});

test('dirent tags symlinks when followSymlinks=false', async ({rig}) => {
  await rig.symlink('target', 'foo', 'file');
  const actual = await glob(['foo'], {
    cwd: rig.temp,
    absolute: false,
    followSymlinks: false,
    includeDirectories: true,
    expandDirectories: false,
    rerootToCwd: false,
    throwIfOutsideCwd: false,
  });
  assert.equal(actual.length, 1);
  assert.equal(actual[0].path, 'foo');
  assert.not(actual[0].dirent.isFile());
  assert.not(actual[0].dirent.isDirectory());
  assert.ok(actual[0].dirent.isSymbolicLink());
});

test('dirent tags symlinks to files as files when followSymlinks=true', async ({
  rig,
}) => {
  await rig.symlink('target', 'foo', 'file');
  await rig.touch('target');
  const actual = await glob(['foo'], {
    cwd: rig.temp,
    absolute: false,
    followSymlinks: true,
    includeDirectories: true,
    expandDirectories: false,
    rerootToCwd: false,
    throwIfOutsideCwd: false,
  });
  assert.equal(actual.length, 1);
  assert.equal(actual[0].path, 'foo');
  assert.ok(actual[0].dirent.isFile());
  assert.not(actual[0].dirent.isDirectory());
  assert.not(actual[0].dirent.isSymbolicLink());
});

test('dirent tags symlinks to directories as directories when followSymlinks=true', async ({
  rig,
}) => {
  await rig.symlink('target', 'foo', 'dir');
  await rig.mkdir('target');
  const actual = await glob(['foo'], {
    cwd: rig.temp,
    absolute: false,
    followSymlinks: true,
    includeDirectories: true,
    expandDirectories: false,
    rerootToCwd: false,
    throwIfOutsideCwd: false,
  });
  assert.equal(actual.length, 1);
  assert.equal(actual[0].path, 'foo');
  assert.not(actual[0].dirent.isFile());
  assert.ok(actual[0].dirent.isDirectory());
  assert.not(actual[0].dirent.isSymbolicLink());
});

test('re-roots to cwd', ({check}) =>
  check({
    files: ['foo'],
    patterns: ['/foo'],
    expected: ['foo'],
    rerootToCwd: true,
  }));

test('re-roots to cwd with exclusion', ({check}) =>
  check({
    files: ['foo', 'bar', 'baz'],
    patterns: ['/*', '!/bar'],
    expected: ['foo', 'baz'],
    rerootToCwd: true,
  }));

test('re-rooting allows ../', ({check}) =>
  check({
    cwd: 'subdir',
    files: ['foo', 'subdir/'],
    patterns: ['../foo'],
    expected: ['../foo'],
    rerootToCwd: true,
  }));

test('re-roots to cwd with braces', ({check}) =>
  check({
    files: ['foo', 'bar'],
    patterns: ['{/foo,/bar}'],
    expected: ['foo', 'bar'],
    rerootToCwd: true,
  }));

test('braces can be escaped', ({check}) =>
  check({
    files: ['{foo,bar}'],
    patterns: ['\\{foo,bar\\}'],
    expected: ['{foo,bar}'],
    rerootToCwd: true,
  }));

test('disallows path outside cwd when throwIfOutsideCwd=true', ({check}) =>
  check({
    cwd: 'subdir',
    files: ['foo', 'subdir/'],
    patterns: ['../foo'],
    expected: 'ERROR',
    throwIfOutsideCwd: true,
  }));

test('allows path outside cwd when throwIfOutsideCwd=false', ({check}) =>
  check({
    cwd: 'subdir',
    files: ['foo', 'subdir/'],
    patterns: ['../foo'],
    expected: ['../foo'],
    throwIfOutsideCwd: false,
  }));

test.run();
