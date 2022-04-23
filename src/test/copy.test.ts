/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {FilesystemTestRig} from './util/filesystem-test-rig.js';
import * as pathlib from 'path';
import {shuffle} from '../util/shuffle.js';
import {windowsifyPathIfOnWindows} from './util/windows.js';
import {copyEntries} from '../util/copy.js';

import type {RelativeEntry} from '../util/glob.js';

const test = suite<{
  src: FilesystemTestRig;
  dst: FilesystemTestRig;

  /** Make a fake glob RelativeEntry that looks like a regular file. */
  file: (path: string) => RelativeEntry;

  /** Make a fake glob RelativeEntry that looks like a directory. */
  dir: (path: string) => RelativeEntry;

  /** Make a fake glob RelativeEntry that looks like a symbolic link. */
  symlink: (path: string) => RelativeEntry;
}>();

test.before.each(async (ctx) => {
  try {
    ctx.src = new FilesystemTestRig();
    ctx.dst = new FilesystemTestRig();
    await ctx.src.setup();
    await ctx.dst.setup();

    ctx.file = (path) =>
      ({
        path: windowsifyPathIfOnWindows(path),
        dirent: {
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        },
      } as RelativeEntry);

    ctx.dir = (path) =>
      ({
        path: windowsifyPathIfOnWindows(path),
        dirent: {
          isFile: () => false,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        },
      } as RelativeEntry);

    ctx.symlink = (path) =>
      ({
        path: windowsifyPathIfOnWindows(path),
        dirent: {
          isFile: () => false,
          isDirectory: () => false,
          isSymbolicLink: () => true,
        },
      } as RelativeEntry);
  } catch (error) {
    // Uvu has a bug where it silently ignores failures in before and after,
    // see https://github.com/lukeed/uvu/issues/191.
    console.error('uvu before error', error);
    process.exit(1);
  }
});

test.after.each(async (ctx) => {
  try {
    await ctx.src.cleanup();
    await ctx.dst.cleanup();
  } catch (error) {
    // Uvu has a bug where it silently ignores failures in before and after,
    // see https://github.com/lukeed/uvu/issues/191.
    console.error('uvu after error', error);
    process.exit(1);
  }
});

test('ignore empty entries', async ({src, dst}) => {
  await copyEntries([], src.temp, dst.temp);
});

test('copy file', async ({src, dst, file}) => {
  await src.write('foo', 'content');
  await copyEntries([file('foo')], src.temp, dst.temp);
  assert.equal(await dst.read('foo'), 'content');
});

test('ignore non-existent file', async ({src, dst, file}) => {
  await copyEntries([file('foo')], src.temp, dst.temp);
  assert.not(await dst.exists('foo'));
});

test('make empty directory', async ({src, dst, dir}) => {
  await src.mkdir('foo');
  await copyEntries([dir('foo')], src.temp, dst.temp);
  assert.ok(await dst.isDirectory('foo'));
});

test('make non-existent directory', async ({src, dst, dir}) => {
  // We don't actually know if a directory really exists or not, so we just
  // create it regardless. We'd have to stat() to find out; better to just trust
  // the glob results being passed in.
  await copyEntries([dir('foo')], src.temp, dst.temp);
  assert.ok(await dst.isDirectory('foo'));
});

test('copy listed directory with listed child', async ({
  src,
  dst,
  file,
  dir,
}) => {
  await src.mkdir('foo');
  await src.write('foo/bar', 'content');
  await copyEntries([file('foo/bar'), dir('foo')], src.temp, dst.temp);
  assert.ok(await dst.isDirectory('foo'));
  assert.equal(await dst.read('foo/bar'), 'content');
});

test('copy listed directory but not its unlisted child', async ({
  src,
  dst,
  dir,
}) => {
  await src.mkdir('foo');
  await src.write('foo/bar', 'content');
  await copyEntries([dir('foo')], src.temp, dst.temp);
  assert.ok(await dst.isDirectory('foo'));
  assert.not(await dst.exists('foo/bar'));
});

test('automatically create parent directory of file', async ({
  src,
  dst,
  file,
}) => {
  // We don't require the parent to be listed explicitly, we create them
  // automatically.
  await src.mkdir('foo');
  await src.write('foo/bar', 'content');
  await copyEntries([file('foo/bar')], src.temp, dst.temp);
  assert.ok(await dst.isDirectory('foo'));
  assert.equal(await dst.read('foo/bar'), 'content');
});

test('automatically create parent directory of directory', async ({
  src,
  dst,
  dir,
}) => {
  // We don't require the parent to be listed explicitly, we create them
  // automatically.
  await src.mkdir('foo/bar');
  await copyEntries([dir('foo/bar')], src.temp, dst.temp);
  assert.ok(await dst.isDirectory('foo'));
  assert.ok(await dst.isDirectory('foo/bar'));
});

test('file that already exists is error', async ({src, dst, file}) => {
  // We error if a file already exists in the destination, because that
  // indicates a bug, like writing to the wrong cache directory.
  await src.write('foo', 'new content');
  await dst.write('foo', 'old content');
  let error;
  try {
    await copyEntries([file('foo')], src.temp, dst.temp);
  } catch (e) {
    error = e;
  }
  assert.instance(error, Error);
  assert.equal((error as {code: string}).code, 'EEXIST');
  assert.equal(await dst.read('foo'), 'old content');
});

test('file listed twice is not an error', async ({src, dst, file}) => {
  // We error if a file already existed in the destination, but we hit that
  // error if the same file was listed twice in the given entries, because we
  // dedupe.
  await src.write('foo', 'content');
  await copyEntries([file('foo'), file('foo')], src.temp, dst.temp);
  assert.equal(await dst.read('foo'), 'content');
});

test('directory that already exists is not error', async ({src, dst, dir}) => {
  // It doesn't really matter if a directory already existed in the destination,
  // because one directory with a given name is as good as another. Plus mkdir()
  // doesn't have an option to check, so we'd have to do an extra stat().
  await src.mkdir('foo');
  await dst.mkdir('foo');
  await copyEntries([dir('foo')], src.temp, dst.temp);
  assert.ok(await dst.isDirectory('foo'));
});

test('directory listed twice is not an error', async ({src, dst, dir}) => {
  await src.mkdir('foo');
  await copyEntries([dir('foo')], src.temp, dst.temp);
  assert.ok(await dst.isDirectory('foo'));
});

test('copies symlink to file verbatim', async ({src, dst, symlink}) => {
  await src.write('foo', 'content');
  await src.symlink('target', 'foo', 'file');
  await copyEntries([symlink('foo')], src.temp, dst.temp);
  assert.equal(await dst.readlink('foo'), 'target');
  assert.not(await dst.exists('target'));
});

test('copies symlink to directory verbatim', async ({src, dst, symlink}) => {
  await src.mkdir('target');
  await src.symlink('target', 'foo', 'dir');
  await copyEntries([symlink('foo')], src.temp, dst.temp);
  assert.equal(await dst.readlink('foo'), 'target');
  assert.not(await dst.exists('target'));
});

test('stress test', async ({src, dst, file, dir}) => {
  const numRoots = 10;
  const depthPerRoot = 10;
  const filesPerDir = 300;

  // Generate a nested file tree.
  // E.g. with numRoots = 2, depthPerRoot = 2, filesPerDir = 2:
  //
  // <temp>
  // ├── r0
  // │   └── d0
  // │       ├── d1
  // │       │   ├── f0
  // │       │   └── f1
  // │       ├── f0
  // │       └── f1
  // └── r1
  //     └── d0
  //         ├── d1
  //         │   ├── f0
  //         │   └── f1
  //         ├── f0
  //         └── f1

  const entries = [];
  let dirPath = '';
  for (let r = 0; r < numRoots; r++) {
    dirPath = `r${r}`;
    entries.push(dir(dirPath));
    for (let d = 0; d < depthPerRoot; d++) {
      dirPath = pathlib.join(dirPath, `d${d}`);
      entries.push(dir(dirPath));
      for (let f = 0; f < filesPerDir; f++) {
        const filePath = pathlib.join(dirPath, `f${f}`);
        entries.push(file(filePath));
        await src.write(filePath, `content for ${filePath}`);
      }
    }
  }

  shuffle(entries);
  await copyEntries(entries, src.temp, dst.temp);
  for (const {path, dirent} of entries) {
    if (dirent.isDirectory()) {
      assert.ok(dst.isDirectory(path));
    } else {
      assert.equal(await dst.read(path), `content for ${path}`);
    }
  }
});

test.run();
