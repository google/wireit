/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {test} from 'node:test';
import * as assert from 'node:assert';
import {FilesystemTestRig} from './util/filesystem-test-rig.js';
import * as pathlib from 'path';
import {shuffle} from '../util/shuffle.js';
import {windowsifyPathIfOnWindows} from './util/windows.js';
import {deleteEntries} from '../util/delete.js';

import type {AbsoluteEntry} from '../util/glob.js';

async function setup(): Promise<
  {
    rig: FilesystemTestRig;

    /** Make a fake glob AbsoluteEntry that looks like a regular file. */
    file: (path: string) => AbsoluteEntry;

    /** Make a fake glob AbsoluteEntry that looks like a directory. */
    dir: (path: string) => AbsoluteEntry;

    /** Make a fake glob Entry that looks like a symlink. */
    symlink: (path: string) => AbsoluteEntry;
  } & AsyncDisposable
> {
  const rig = new FilesystemTestRig();
  await rig.setup();

  const file = (path: string) =>
    ({
      path: windowsifyPathIfOnWindows(pathlib.join(rig.temp, path)),
      dirent: {
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      },
    }) as AbsoluteEntry;

  const dir = (path: string) =>
    ({
      path: windowsifyPathIfOnWindows(pathlib.join(rig.temp, path)),
      dirent: {
        isFile: () => false,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      },
    }) as AbsoluteEntry;

  const symlink = (path: string) =>
    ({
      path: windowsifyPathIfOnWindows(pathlib.join(rig.temp, path)),
      dirent: {
        isFile: () => false,
        isDirectory: () => false,
        isSymbolicLink: () => true,
      },
    }) as AbsoluteEntry;

  return {
    rig,
    file,
    dir,
    symlink,
    [Symbol.asyncDispose]: () => rig.cleanup(),
  };
}

void test('ignore empty entries', async () => {
  await deleteEntries([]);
});

void test('delete 1 file', async () => {
  await using context = await setup();
  const {rig, file} = context;
  await rig.touch('foo');
  await deleteEntries([file('foo')]);
  assert.ok(!(await rig.exists('foo')));
});

void test('ignore non-existent file', async () => {
  await using context = await setup();
  const {rig, file} = context;
  await deleteEntries([file('foo')]);
  assert.ok(!(await rig.exists('foo')));
});

void test('delete 1 directory', async () => {
  await using context = await setup();
  const {rig, dir} = context;
  await rig.mkdir('foo');
  await deleteEntries([dir('foo')]);
  assert.ok(!(await rig.exists('foo')));
});

void test('ignore non-existent directory', async () => {
  await using context = await setup();
  const {rig, dir} = context;
  await deleteEntries([dir('foo')]);
  assert.ok(!(await rig.exists('foo')));
});

void test('delete 1 directory and its 1 file', async () => {
  await using context = await setup();
  const {rig, file, dir} = context;
  await rig.mkdir('foo');
  await rig.touch('foo/bar');
  await deleteEntries([file('foo/bar'), dir('foo')]);
  assert.ok(!(await rig.exists('foo/bar')));
  assert.ok(!(await rig.exists('foo')));
});

void test('ignore non-empty directory', async () => {
  await using context = await setup();
  const {rig, dir} = context;
  await rig.mkdir('foo');
  await rig.touch('foo/bar');
  await deleteEntries([dir('foo')]);
  assert.ok(await rig.exists('foo/bar'));
  assert.ok(await rig.exists('foo'));
});

void test('delete child directory but not parent', async () => {
  await using context = await setup();
  const {rig, dir} = context;
  await rig.mkdir('foo/bar');
  await deleteEntries([dir('foo/bar')]);
  assert.ok(!(await rig.exists('foo/bar')));
  assert.ok(await rig.exists('foo'));
});

void test('grandparent and child scheduled for delete, but not parent', async () => {
  await using context = await setup();
  const {rig, dir} = context;
  await rig.mkdir('foo/bar/baz');
  await deleteEntries([dir('foo'), dir('foo/bar/baz')]);
  assert.ok(!(await rig.exists('foo/bar/baz')));
  assert.ok(await rig.exists('foo'));
  assert.ok(await rig.exists('foo/bar'));
});

void test('delete child directories before parents', async () => {
  await using context = await setup();
  const {rig, dir} = context;
  await rig.mkdir('a/b/c/d');
  const entries = [dir('a/b/c'), dir('a'), dir('a/b/c/d'), dir('a/b')];
  await deleteEntries(entries);
  assert.ok(!(await rig.exists('a/b/c/d')));
  assert.ok(!(await rig.exists('a/b/c')));
  assert.ok(!(await rig.exists('a/b')));
  assert.ok(!(await rig.exists('a')));
});

void test('delete symlink to existing file but not its target', async () => {
  await using context = await setup();
  const {rig, symlink} = context;
  await rig.write('target', 'content');
  await rig.symlink('target', 'symlink', 'file');
  const entries = [symlink('symlink')];
  await deleteEntries(entries);
  assert.ok(!(await rig.exists('symlink')));
  assert.equal(await rig.read('target'), 'content');
});

void test('delete symlink to existing directory but not its target', async () => {
  await using context = await setup();
  const {rig, symlink} = context;
  await rig.mkdir('target');
  await rig.symlink('target', 'symlink', 'dir');
  const entries = [symlink('symlink')];
  await deleteEntries(entries);
  assert.ok(!(await rig.exists('symlink')));
  assert.ok(await rig.isDirectory('target'));
});

void test('delete symlink to non-existing file', async () => {
  await using context = await setup();
  const {rig, symlink} = context;
  await rig.symlink('target', 'symlink', 'file');
  const entries = [symlink('symlink')];
  await deleteEntries(entries);
  assert.ok(!(await rig.exists('symlink')));
});

void test('stress test', async () => {
  await using context = await setup();
  const {rig, file, dir} = context;
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
    entries.map(async (entry) => assert.ok(!(await rig.exists(entry.path)))),
  );
});
