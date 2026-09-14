/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {test} from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as pathlib from 'path';
import {execFileSync} from 'child_process';
import {detectWorktree, resolveCachePackageDir} from '../util/cache-root.js';
import {FilesystemTestRig} from './util/filesystem-test-rig.js';

const git = (cwd: string, args: string[]) => {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
};

const initRepo = (dir: string) => {
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'wireit@example.com']);
  git(dir, ['config', 'user.name', 'Wireit Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
};

const withRig = async (
  fn: (rig: FilesystemTestRig) => Promise<void>,
): Promise<void> => {
  const rig = new FilesystemTestRig();
  await rig.setup();
  try {
    await fn(rig);
  } finally {
    await rig.cleanup();
  }
};

void test('main worktree uses its own package dir', async () => {
  await withRig(async (rig) => {
    initRepo(rig.temp);
    await rig.write('README.md', 'x');
    git(rig.temp, ['add', '.']);
    git(rig.temp, ['commit', '-m', 'init']);
    const pkg = rig.resolve('packages/foo');
    await rig.mkdir('packages/foo');
    const info = detectWorktree(pkg);
    assert.equal(
      info && fs.realpathSync(info.worktreeRoot),
      fs.realpathSync(rig.temp),
    );
    assert.equal(
      info && fs.realpathSync(info.mainWorktreeRoot),
      fs.realpathSync(rig.temp),
    );
    assert.equal(resolveCachePackageDir(pkg), pkg);
  });
});

void test('linked worktree cache package dir maps onto the main tree', async () => {
  await withRig(async (rig) => {
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
    const info = detectWorktree(linkedPkg);
    assert.equal(
      info && fs.realpathSync(info.worktreeRoot),
      fs.realpathSync(linked),
    );
    assert.equal(
      info && fs.realpathSync(info.mainWorktreeRoot),
      fs.realpathSync(main),
    );
    assert.equal(
      fs.realpathSync(resolveCachePackageDir(linkedPkg)),
      fs.realpathSync(mainPkg),
    );
  });
});

void test('WIREIT_CACHE_DIR keys packages relative to the worktree root', async () => {
  await withRig(async (rig) => {
    initRepo(rig.temp);
    await rig.write('README.md', 'x');
    git(rig.temp, ['add', '.']);
    git(rig.temp, ['commit', '-m', 'init']);
    const pkg = rig.resolve('packages/foo');
    await rig.mkdir('packages/foo');
    const cacheDir = rig.resolve('shared-cache');
    assert.equal(
      resolveCachePackageDir(pkg, cacheDir),
      pathlib.join(cacheDir, 'packages', 'foo'),
    );
  });
});
