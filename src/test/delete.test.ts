/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import 'source-map-support/register.js';
import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {FilesystemTestRig} from './util/filesystem-test-rig.js';
import * as pathlib from 'path';
import {shuffle} from '../util/shuffle.js';
import {windowsifyPathIfOnWindows} from './util/windows.js';
import {deleteEntries} from '../util/delete.js';

import type {AbsoluteEntry} from '../util/glob.js';

const test = suite<{
  rig: FilesystemTestRig;

  /** Make a fake glob AbsoluteEntry that looks like a regular file. */
  file: (path: string) => AbsoluteEntry;

  /** Make a fake glob AbsoluteEntry that looks like a directory. */
  dir: (path: string) => AbsoluteEntry;

  /** Make a fake glob Entry that looks like a symlink. */
  symlink: (path: string) => AbsoluteEntry;
}>();

test.before.each(async (ctx) => {
  try {
    const rig = (ctx.rig = new FilesystemTestRig());
    await rig.setup();

    ctx.file = (path) =>
      ({
        path: windowsifyPathIfOnWindows(pathlib.join(rig.temp, path)),
        dirent: {
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        },
      } as AbsoluteEntry);

    ctx.dir = (path) =>
      ({
        path: windowsifyPathIfOnWindows(pathlib.join(rig.temp, path)),
        dirent: {
          isFile: () => false,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        },
      } as AbsoluteEntry);

    ctx.symlink = (path) =>
      ({
        path: windowsifyPathIfOnWindows(pathlib.join(rig.temp, path)),
        dirent: {
          isFile: () => false,
          isDirectory: () => false,
          isSymbolicLink: () => true,
        },
      } as AbsoluteEntry);
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

test('ignore empty entries', async () => {
  await deleteEntries([]);
});

test('delete 1 file', async ({rig, file}) => {
  await rig.touch('foo');
  await deleteEntries([file('foo')]);
  assert.not(await rig.exists('foo'));
});

test('ignore non-existent file', async ({rig, file}) => {
  await deleteEntries([file('foo')]);
  assert.not(await rig.exists('foo'));
});

test('delete 1 directory', async ({rig, dir}) => {
  await rig.mkdir('foo');
  await deleteEntries([dir('foo')]);
  assert.not(await rig.exists('foo'));
});

test('ignore non-existent directory', async ({rig, dir}) => {
  await deleteEntries([dir('foo')]);
  assert.not(await rig.exists('foo'));
});

test('delete 1 directory and its 1 file', async ({rig, file, dir}) => {
  await rig.mkdir('foo');
  await rig.touch('foo/bar');
  await deleteEntries([file('foo/bar'), dir('foo')]);
  assert.not(await rig.exists('foo/bar'));
  assert.not(await rig.exists('foo'));
});

test('ignore non-empty directory', async ({rig, dir}) => {
  await rig.mkdir('foo');
  await rig.touch('foo/bar');
  await deleteEntries([dir('foo')]);
  assert.ok(await rig.exists('foo/bar'));
  assert.ok(await rig.exists('foo'));
});

test('delete child directory but not parent', async ({rig, dir}) => {
  await rig.mkdir('foo/bar');
  await deleteEntries([dir('foo/bar')]);
  assert.not(await rig.exists('foo/bar'));
  assert.ok(await rig.exists('foo'));
});

test('grandparent and child scheduled for delete, but not parent', async ({
  rig,
  dir,
}) => {
  await rig.mkdir('foo/bar/baz');
  await deleteEntries([dir('foo'), dir('foo/bar/baz')]);
  assert.not(await rig.exists('foo/bar/baz'));
  assert.ok(await rig.exists('foo'));
  assert.ok(await rig.exists('foo/bar'));
});

test('delete child directories before parents', async ({rig, dir}) => {
  await rig.mkdir('a/b/c/d');
  const entries = [dir('a/b/c'), dir('a'), dir('a/b/c/d'), dir('a/b')];
  await deleteEntries(entries);
  assert.not(await rig.exists('a/b/c/d'));
  assert.not(await rig.exists('a/b/c'));
  assert.not(await rig.exists('a/b'));
  assert.not(await rig.exists('a'));
});

test('delete symlink to existing file but not its target', async ({
  rig,
  symlink,
}) => {
  await rig.write('target', 'content');
  await rig.symlink('target', 'symlink', 'file');
  const entries = [symlink('symlink')];
  await deleteEntries(entries);
  assert.not(await rig.exists('symlink'));
  assert.equal(await rig.read('target'), 'content');
});

test('delete symlink to existing directory but not its target', async ({
  rig,
  symlink,
}) => {
  await rig.mkdir('target');
  await rig.symlink('target', 'symlink', 'dir');
  const entries = [symlink('symlink')];
  await deleteEntries(entries);
  assert.not(await rig.exists('symlink'));
  assert.ok(await rig.isDirectory('target'));
});

test('delete symlink to non-existing file', async ({rig, symlink}) => {
  await rig.symlink('target', 'symlink', 'file');
  const entries = [symlink('symlink')];
  await deleteEntries(entries);
  assert.not(await rig.exists('symlink'));
});

test('stress test', async ({rig, file, dir}) => {
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
        await rig.touch(filePath);
      }
    }
  }

  shuffle(entries);
  await deleteEntries(entries);
  await Promise.all(
    entries.map(async (entry) => assert.not(await rig.exists(entry.path)))
  );
});

test.run();
