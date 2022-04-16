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
  expected: string[];
  cwd?: string;
  absolute?: boolean;
  includeDirectories?: boolean;
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

      if (pathlib.sep === '\\') {
        // On Windows we expect to get results back with "\" as the separator.
        expected = expected.map((path) => path.replaceAll('/', '\\'));
      }

      const actual = await glob(patterns, {
        cwd,
        absolute,
        includeDirectories,
      });
      assert.equal(actual.sort(), expected.sort());
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

test('* star includes directory when includeDirectories=false', ({check}) =>
  check({
    files: ['foo/'],
    patterns: ['*'],
    expected: [],
  }));

test('* star excludes directory when includeDirectories=true', ({check}) =>
  check({
    files: ['foo/'],
    patterns: ['*'],
    expected: ['foo'],
    includeDirectories: true,
  }));

test.run();
