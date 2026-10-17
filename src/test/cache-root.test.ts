/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {test} from 'node:test';
import * as assert from 'node:assert';
import * as pathlib from 'path';
import {realpath} from '../util/fs.js';
import {detectWorktree, resolveCachePackageDir} from '../util/cache-root.js';
import {FilesystemTestRig} from './util/filesystem-test-rig.js';
import {git, initRepo} from './util/git.js';

void test('main worktree uses its own package dir', async () => {
  await using rig = await FilesystemTestRig.setup();
  initRepo(rig.temp);
  await rig.write('README.md', 'x');
  git(rig.temp, ['add', '.']);
  git(rig.temp, ['commit', '-m', 'init']);
  const pkg = rig.resolve('packages/foo');
  await rig.mkdir('packages/foo');
  const info = await detectWorktree(pkg);
  assert.ok(info);
  assert.equal(await realpath(info.worktreeRoot), await realpath(rig.temp));
  assert.equal(await realpath(info.mainWorktreeRoot), await realpath(rig.temp));
  assert.equal(await resolveCachePackageDir(pkg, {shareWorktrees: true}), pkg);
});

void test('linked worktree keeps its own cache package dir unless sharing', async () => {
  await using rig = await FilesystemTestRig.setup();
  const main = rig.resolve('main');
  const linked = rig.resolve('linked');
  await rig.mkdir('main');
  initRepo(main);
  await rig.write(pathlib.join('main', 'README.md'), 'x');
  git(main, ['add', '.']);
  git(main, ['commit', '-m', 'init']);
  git(main, ['worktree', 'add', linked, '-b', 'other']);
  const linkedPkg = pathlib.join(linked, 'packages', 'foo');
  await rig.mkdir(pathlib.join('linked', 'packages', 'foo'));
  assert.equal(await resolveCachePackageDir(linkedPkg), linkedPkg);
});

void test('linked worktree cache package dir maps onto the main tree when sharing', async () => {
  await using rig = await FilesystemTestRig.setup();
  const main = rig.resolve('main');
  const linked = rig.resolve('linked');
  await rig.mkdir('main');
  initRepo(main);
  await rig.write(pathlib.join('main', 'README.md'), 'x');
  git(main, ['add', '.']);
  git(main, ['commit', '-m', 'init']);
  git(main, ['worktree', 'add', linked, '-b', 'other']);
  const mainPkg = pathlib.join(main, 'packages', 'foo');
  const linkedPkg = pathlib.join(linked, 'packages', 'foo');
  await rig.mkdir(pathlib.join('main', 'packages', 'foo'));
  await rig.mkdir(pathlib.join('linked', 'packages', 'foo'));
  const info = await detectWorktree(linkedPkg);
  assert.ok(info);
  assert.equal(await realpath(info.worktreeRoot), await realpath(linked));
  assert.equal(await realpath(info.mainWorktreeRoot), await realpath(main));
  assert.equal(
    await realpath(
      await resolveCachePackageDir(linkedPkg, {shareWorktrees: true}),
    ),
    await realpath(mainPkg),
  );
});

void test('worktree inside main checkout maps cache into matching package dir', async () => {
  await using rig = await FilesystemTestRig.setup();
  const main = rig.resolve('main');
  const linked = pathlib.join(main, '.claude', 'worktrees', 'linked');
  await rig.mkdir('main');
  initRepo(main);
  await rig.write(pathlib.join('main', 'README.md'), 'x');
  git(main, ['add', '.']);
  git(main, ['commit', '-m', 'init']);
  await rig.mkdir(pathlib.join('main', '.claude', 'worktrees'));
  git(main, ['worktree', 'add', linked, '-b', 'other']);
  const mainPkg = pathlib.join(main, 'packages', 'foo');
  const linkedPkg = pathlib.join(linked, 'packages', 'foo');
  await rig.mkdir(pathlib.join('main', 'packages', 'foo'));
  await rig.mkdir(
    pathlib.join('.claude', 'worktrees', 'linked', 'packages', 'foo'),
  );

  assert.equal(
    await realpath(
      await resolveCachePackageDir(linkedPkg, {shareWorktrees: true}),
    ),
    await realpath(mainPkg),
  );
});

void test('bare clone worktree keeps its own cache package dir', async () => {
  await using rig = await FilesystemTestRig.setup();
  const main = rig.resolve('main');
  const bare = rig.resolve('bare.git');
  const linked = rig.resolve('linked');
  await rig.mkdir('main');
  initRepo(main);
  await rig.write(pathlib.join('main', 'README.md'), 'x');
  git(main, ['add', '.']);
  git(main, ['commit', '-m', 'init']);
  git(rig.temp, ['clone', '--bare', main, bare]);
  git(rig.temp, ['--git-dir', bare, 'worktree', 'add', linked, '-b', 'other']);
  const linkedPkg = pathlib.join(linked, 'packages', 'foo');
  await rig.mkdir(pathlib.join('linked', 'packages', 'foo'));
  // The bare dir's parent isn't a checkout, so sharing would land outside it.
  assert.equal(
    await resolveCachePackageDir(linkedPkg, {shareWorktrees: true}),
    linkedPkg,
  );
});

void test('separate git dir worktree keeps its own cache package dir', async () => {
  await using rig = await FilesystemTestRig.setup();
  const main = rig.resolve('main');
  const gitDir = rig.resolve('sep-git');
  const checkout = rig.resolve('checkout');
  const linked = rig.resolve('linked');
  await rig.mkdir('main');
  initRepo(main);
  await rig.write(pathlib.join('main', 'README.md'), 'x');
  git(main, ['add', '.']);
  git(main, ['commit', '-m', 'init']);
  git(rig.temp, ['clone', '--separate-git-dir', gitDir, main, checkout]);
  git(checkout, ['worktree', 'add', linked, '-b', 'other']);
  const linkedPkg = pathlib.join(linked, 'packages', 'foo');
  await rig.mkdir(pathlib.join('linked', 'packages', 'foo'));
  // The git dir isn't named `.git`, so its parent isn't a checkout.
  assert.equal(
    await resolveCachePackageDir(linkedPkg, {shareWorktrees: true}),
    linkedPkg,
  );
});

void test('submodule worktree keeps its own cache package dir', async () => {
  await using rig = await FilesystemTestRig.setup();
  const subSrc = rig.resolve('sub-src');
  const superRepo = rig.resolve('super');
  const linked = rig.resolve('linked');
  for (const dir of [subSrc, superRepo]) {
    await rig.mkdir(pathlib.relative(rig.temp, dir));
    initRepo(dir);
  }
  await rig.write(pathlib.join('sub-src', 'f.txt'), 'x');
  git(subSrc, ['add', '.']);
  git(subSrc, ['commit', '-m', 'init']);
  await rig.write(pathlib.join('super', 'README.md'), 'x');
  git(superRepo, ['add', '.']);
  git(superRepo, ['commit', '-m', 'init']);
  git(superRepo, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    subSrc,
    'sub',
  ]);
  git(superRepo, ['commit', '-m', 'addsub']);
  const sub = pathlib.join(superRepo, 'sub');
  git(sub, ['worktree', 'add', linked, '-b', 'other']);
  const linkedPkg = pathlib.join(linked, 'packages', 'foo');
  await rig.mkdir(pathlib.join('linked', 'packages', 'foo'));
  // The shared config sets `core.worktree`, so sharing would land inside the
  // outer repo's git folder.
  assert.equal(
    await resolveCachePackageDir(linkedPkg, {shareWorktrees: true}),
    linkedPkg,
  );
});
