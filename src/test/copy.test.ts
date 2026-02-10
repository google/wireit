/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {test} from 'node:test';
import * as assert from 'node:assert';
import {FilesystemTestRig} from './util/filesystem-test-rig.js';
import * as pathlib from 'path';
import * as fs from 'fs/promises';
import {shuffle} from '../util/shuffle.js';
import {windowsifyPathIfOnWindows} from './util/windows.js';
import {copyEntries} from '../util/copy.js';

import type {AbsoluteEntry} from '../util/glob.js';

async function setup(): Promise<
  {
    src: FilesystemTestRig;
    dst: FilesystemTestRig;

    /** Make a fake glob AbsoluteEntry that looks like a regular file. */
    file: (path: string) => AbsoluteEntry;

    /** Make a fake glob AbsoluteEntry that looks like a directory. */
    dir: (path: string) => AbsoluteEntry;

    /** Make a fake glob AbsoluteEntry that looks like a symbolic link. */
    symlink: (path: string) => AbsoluteEntry;
  } & AsyncDisposable
> {
  const src = new FilesystemTestRig();
  const dst = new FilesystemTestRig();
  await src.setup();
  await dst.setup();

  const file = (path: string) =>
    ({
      path: src.resolve(windowsifyPathIfOnWindows(path)),
      dirent: {
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      },
    }) as AbsoluteEntry;

  const dir = (path: string) =>
    ({
      path: src.resolve(windowsifyPathIfOnWindows(path)),
      dirent: {
        isFile: () => false,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      },
    }) as AbsoluteEntry;

  const symlink = (path: string) =>
    ({
      path: src.resolve(windowsifyPathIfOnWindows(path)),
      dirent: {
        isFile: () => false,
        isDirectory: () => false,
        isSymbolicLink: () => true,
      },
    }) as AbsoluteEntry;

  return {
    src,
    dst,
    file,
    dir,
    symlink,
    async [Symbol.asyncDispose]() {
      await src.cleanup();
      await dst.cleanup();
    },
  };
}

void test('ignore empty entries', async () => {
  await using context = await setup();
  const {src, dst} = context;
  await copyEntries([], src.temp, dst.temp);
});

void test('copy file', async () => {
  await using context = await setup();
  const {src, dst, file} = context;
  await src.write('foo', 'content');
  await copyEntries([file('foo')], src.temp, dst.temp);
  assert.deepStrictEqual(await dst.read('foo'), 'content');
});

void test('ignore non-existent file', async () => {
  await using context = await setup();
  const {src, dst, file} = context;
  await copyEntries([file('foo')], src.temp, dst.temp);
  assert.ok(!(await dst.exists('foo')));
});

void test('make empty directory', async () => {
  await using context = await setup();
  const {src, dst, dir} = context;
  await src.mkdir('foo');
  await copyEntries([dir('foo')], src.temp, dst.temp);
  assert.ok(await dst.isDirectory('foo'));
});

void test('make non-existent directory', async () => {
  await using context = await setup();
  const {src, dst, dir} = context;
  // We don't actually know if a directory really exists or not, so we just
  // create it regardless. We'd have to stat() to find out; better to just trust
  // the glob results being passed in.
  await copyEntries([dir('foo')], src.temp, dst.temp);
  assert.ok(await dst.isDirectory('foo'));
});

void test('copy listed directory with listed child', async () => {
  await using context = await setup();
  const {src, dst, file, dir} = context;
  await src.mkdir('foo');
  await src.write('foo/bar', 'content');
  await copyEntries([file('foo/bar'), dir('foo')], src.temp, dst.temp);
  assert.ok(await dst.isDirectory('foo'));
  assert.deepStrictEqual(await dst.read('foo/bar'), 'content');
});

void test('copy listed directory but not its unlisted child', async () => {
  await using context = await setup();
  const {src, dst, dir} = context;
  await src.mkdir('foo');
  await src.write('foo/bar', 'content');
  await copyEntries([dir('foo')], src.temp, dst.temp);
  assert.ok(await dst.isDirectory('foo'));
  assert.ok(!(await dst.exists('foo/bar')));
});

void test('automatically create parent directory of file', async () => {
  await using context = await setup();
  const {src, dst, file} = context;
  // We don't require the parent to be listed explicitly, we create them
  // automatically.
  await src.mkdir('foo');
  await src.write('foo/bar', 'content');
  await copyEntries([file('foo/bar')], src.temp, dst.temp);
  assert.ok(await dst.isDirectory('foo'));
  assert.deepStrictEqual(await dst.read('foo/bar'), 'content');
});

void test('automatically create parent directory of directory', async () => {
  await using context = await setup();
  const {src, dst, dir} = context;
  // We don't require the parent to be listed explicitly, we create them
  // automatically.
  await src.mkdir('foo/bar');
  await copyEntries([dir('foo/bar')], src.temp, dst.temp);
  assert.ok(await dst.isDirectory('foo'));
  assert.ok(await dst.isDirectory('foo/bar'));
});

void test('file that already exists is error', async () => {
  await using context = await setup();
  const {src, dst, file} = context;
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
  assert.ok(error instanceof Error);
  assert.deepStrictEqual((error as unknown as {code: string}).code, 'EEXIST');
  assert.deepStrictEqual(await dst.read('foo'), 'old content');
});

void test('file listed twice is not an error', async () => {
  await using context = await setup();
  const {src, dst, file} = context;
  // We error if a file already existed in the destination, but not if the same
  // file was listed twice in the given entries, because we dedupe.
  await src.write('foo', 'content');
  await copyEntries([file('foo'), file('foo')], src.temp, dst.temp);
  assert.deepStrictEqual(await dst.read('foo'), 'content');
});

void test('directory that already exists is not error', async () => {
  await using context = await setup();
  const {src, dst, dir} = context;
  // It doesn't really matter if a directory already existed in the destination,
  // because one directory with a given name is as good as another. Plus mkdir()
  // doesn't have an option to check, so we'd have to do an extra stat().
  await src.mkdir('foo');
  await dst.mkdir('foo');
  await copyEntries([dir('foo')], src.temp, dst.temp);
  assert.ok(await dst.isDirectory('foo'));
});

void test('directory listed twice is not an error', async () => {
  await using context = await setup();
  const {src, dst, dir} = context;
  await src.mkdir('foo');
  await copyEntries([dir('foo'), dir('foo')], src.temp, dst.temp);
  assert.ok(await dst.isDirectory('foo'));
});

void test('copies symlink to file verbatim', async () => {
  await using context = await setup();
  const {src, dst, symlink} = context;
  await src.write('target', 'content');
  await src.symlink('target', 'symlink', 'file');
  await copyEntries([symlink('symlink')], src.temp, dst.temp);
  assert.deepStrictEqual(await dst.readlink('symlink'), 'target');
  assert.ok(!(await dst.exists('target')));

  // If we create the target file, we should now be able to read it. This is
  // mostly to confirm we created the right kind of symlink on Windows.
  await dst.write('target', 'content');
  assert.deepStrictEqual(await dst.read('symlink'), 'content');
});

void test('copies symlink to directory verbatim', async () => {
  await using context = await setup();
  const {src, dst, symlink} = context;
  await src.mkdir('target');
  await src.symlink('target', 'symlink', 'dir');
  await copyEntries([symlink('symlink')], src.temp, dst.temp);
  assert.deepStrictEqual(await dst.readlink('symlink'), 'target');
  assert.ok(!(await dst.exists('target')));

  // If we create the target directory, we should now be able to list it. This
  // is mostly to confirm we created the right kind of symlink on Windows.
  await dst.mkdir('target');
  await dst.touch('target/child');
  assert.deepStrictEqual(await fs.readdir(dst.resolve('symlink')), ['child']);
});

void test('stress test', async () => {
  await using context = await setup();
  const {src, dst, file, dir} = context;
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
        const entry = file(filePath);
        entries.push(file(filePath));
        await src.write(filePath, `content for ${entry.path}`);
      }
    }
  }

  shuffle(entries);
  await copyEntries(entries, src.temp, dst.temp);
  for (const {path, dirent} of entries) {
    if (dirent.isDirectory()) {
      assert.ok(dst.isDirectory(path));
    } else {
      assert.deepStrictEqual(await dst.read(path), `content for ${path}`);
    }
  }
});
