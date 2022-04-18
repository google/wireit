/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as pathlib from 'path';
import * as assert from 'uvu/assert';
import {suite} from 'uvu';
import {glob} from '../util/glob.js';
import {fileURLToPath} from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathlib.dirname(__filename);
const repoRoot = pathlib.resolve(__dirname, '..', '..', '..');

interface Symlink {
  /** Where the symlink file points to. */
  target: string;
  /** The symlink file. */
  path: string;
}

interface TestCase {
  files: Array<string | Symlink>;
  patterns: string[];
  expected: string[] | 'ERROR';
  cwd?: string;
  absolute?: boolean;
  includeDirectories?: boolean;
  expandDirectories?: boolean;
}

const test = suite<{
  temp: string;
  check: (data: TestCase) => Promise<void>;
}>();

test.before.each(async (ctx) => {
  try {
    ctx.temp = pathlib.resolve(repoRoot, 'temp', 'glob', String(Math.random()));
    await fs.mkdir(ctx.temp, {recursive: true});

    ctx.check = async ({
      files,
      patterns,
      expected,
      cwd = ctx.temp,
      absolute = false,
      includeDirectories = false,
      expandDirectories = false,
    }: TestCase): Promise<void> => {
      for (const file of files) {
        if (typeof file === 'string') {
          const abs = pathlib.join(ctx.temp, file);
          if (file.endsWith('/')) {
            // directory
            await fs.mkdir(abs, {recursive: true});
          } else {
            // file
            await fs.mkdir(pathlib.dirname(abs), {recursive: true});
            await fs.writeFile(abs, 'utf8');
          }
        } else {
          // symlink
          const abs = pathlib.join(ctx.temp, file.path);
          await fs.mkdir(pathlib.dirname(abs), {recursive: true});
          await fs.symlink(file.target, abs);
        }
      }

      if (pathlib.sep === '\\' && expected !== 'ERROR') {
        // On Windows we expect to get results back with "\" as the separator.
        expected = expected.map((path) => path.replaceAll('/', '\\'));
      }

      let actual, error;
      try {
        actual = await glob(patterns, {
          cwd,
          absolute,
          includeDirectories,
          expandDirectories,
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
        assert.equal(actual.sort(), expected.sort());
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
    await fs.rm(ctx.temp, {recursive: true});
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
    files: ['target', {target: 'target', path: 'symlink'}],
    patterns: ['symlink'],
    expected: ['symlink'],
  }));

test('absolute', ({check, temp}) =>
  check({
    files: ['foo'],
    patterns: ['foo'],
    expected: [pathlib.join(temp, 'foo')],
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

test.run();
