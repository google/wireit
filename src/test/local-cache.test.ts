/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {test} from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs/promises';
import * as pathlib from 'path';
import {createHash} from 'crypto';
import lockfile from 'proper-lockfile';
import {LocalCache} from '../caching/local-cache.js';
import {Fingerprint} from '../fingerprint.js';
import {getScriptDataDir} from '../util/script-data-dir.js';
import {FilesystemTestRig} from './util/filesystem-test-rig.js';
import {FsGate} from './util/fs-gate.js';
import {git, initRepo} from './util/git.js';

import type {AbsoluteEntry} from '../util/glob.js';
import type {FingerprintString} from '../fingerprint.js';
import type {ScriptReference} from '../config.js';

// Eviction of least recently used cache entries.
// https://github.com/google/wireit/issues/71

const SCRIPT_NAME = 'a';

async function setup(
  maxEntries: number,
  shareWorktrees = false,
): Promise<
  {
    rig: FilesystemTestRig;
    cache: LocalCache;
    script: ScriptReference;

    /** The script's cache folder, one directory per entry. */
    cacheDir: string;

    /** Write `<name>` to the "output" file and cache it under `name`. */
    cacheOutput: (name: string) => Promise<void>;

    /** The names of the entries currently in the script's cache folder. */
    entryHashes: () => Promise<string[]>;

    /** Set an entry's recency directly, instead of racing the wall clock. */
    setRecency: (name: string, secondsSinceEpoch: number) => Promise<void>;

    /** The package's trash folder, where evicted entries wait to be swept. */
    trashDir: string;

    /** The names of the evicted entries waiting to be swept. */
    trashEntries: () => Promise<string[]>;

    /** The "output" file, as {@link LocalCache.set} takes it. */
    outputEntry: AbsoluteEntry;

    /** The names in the script's folder of entries still being written. */
    tempEntries: () => Promise<string[]>;
  } & AsyncDisposable
> {
  const rig = new FilesystemTestRig();
  await rig.setup();
  const script: ScriptReference = {
    packageDir: rig.resolve('.'),
    name: SCRIPT_NAME,
  };
  const cache = new LocalCache(maxEntries, {shareWorktrees});
  const cacheDir = pathlib.join(getScriptDataDir(script), 'cache');
  const trashDir = rig.resolve(pathlib.join('.wireit', 'trash'));

  const outputEntry: AbsoluteEntry = {
    path: rig.resolve('output'),
    dirent: {
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    },
  } as AbsoluteEntry;

  const cacheOutput = async (name: string) => {
    await rig.write({output: name});
    assert.equal(
      await cache.set(script, fingerprint(name), [outputEntry]),
      true,
    );
  };

  const entryHashes = () => readdirIfExists(cacheDir);

  const setRecency = async (name: string, secondsSinceEpoch: number) => {
    const when = new Date(secondsSinceEpoch * 1000);
    await fs.utimes(pathlib.join(cacheDir, hashOf(name)), when, when);
  };

  const trashEntries = () => readdirIfExists(trashDir);

  const tempEntries = () =>
    readdirIfExists(pathlib.join(getScriptDataDir(script), 'temp'));

  return {
    rig,
    cache,
    script,
    cacheDir,
    cacheOutput,
    entryHashes,
    setRecency,
    trashDir,
    trashEntries,
    outputEntry,
    tempEntries,
    [Symbol.asyncDispose]: () => rig.cleanup(),
  };
}

async function readdirIfExists(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).sort();
  } catch (error) {
    if ((error as {code?: string}).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/** Takes an entry's lock the same way {@link LocalCache} does. */
const lockEntry = (lockFile: string) =>
  lockfile.lock(lockFile, {stale: 10_000, retries: 0, realpath: false});

/** The cache only keys off the string form, so any distinct string works. */
const fingerprint = (name: string) =>
  Fingerprint.fromString(name as FingerprintString);

const hashOf = (name: string) =>
  createHash('sha256').update(name).digest('hex');

void test('retains entries up to the limit without evicting', async () => {
  await using ctx = await setup(3);
  for (const name of ['v0', 'v1', 'v2']) {
    await ctx.cacheOutput(name);
  }
  assert.deepEqual(
    await ctx.entryHashes(),
    ['v0', 'v1', 'v2'].map(hashOf).sort(),
  );
});

void test('evicts down to the limit when it is exceeded', async () => {
  await using ctx = await setup(2);
  for (const [index, name] of ['v0', 'v1', 'v2', 'v3'].entries()) {
    await ctx.cacheOutput(name);
    await ctx.setRecency(name, 1_000 + index);
  }
  assert.deepEqual(await ctx.entryHashes(), ['v2', 'v3'].map(hashOf).sort());
});

void test('a folder far over the limit shrinks by one entry per write', async () => {
  await using ctx = await setup(2);
  // Entries written before there was a limit.
  const legacy = ['v0', 'v1', 'v2', 'v3', 'v4', 'v5'];
  for (const [index, name] of legacy.entries()) {
    await fs.mkdir(pathlib.join(ctx.cacheDir, hashOf(name)), {recursive: true});
    await ctx.setRecency(name, 1_000 + index);
  }

  await ctx.cacheOutput('n0');
  await ctx.setRecency('n0', 2_000);
  // Only the two least recently used entries go, not all five over the limit.
  assert.deepEqual(
    await ctx.entryHashes(),
    ['v2', 'v3', 'v4', 'v5', 'n0'].map(hashOf).sort(),
  );
  assert.equal((await ctx.trashEntries()).length, 2);

  const sizes = [];
  for (const [index, name] of ['n1', 'n2', 'n3', 'n4'].entries()) {
    await ctx.cacheOutput(name);
    await ctx.setRecency(name, 2_001 + index);
    sizes.push((await ctx.entryHashes()).length);
  }
  assert.deepEqual(sizes, [4, 3, 2, 2]);
  assert.deepEqual(await ctx.entryHashes(), ['n3', 'n4'].map(hashOf).sort());
});

void test('evicts the least recently used entry, not the oldest', async () => {
  await using ctx = await setup(2);
  await ctx.cacheOutput('v0');
  await ctx.setRecency('v0', 1_000);
  await ctx.cacheOutput('v1');
  await ctx.setRecency('v1', 1_001);

  // Reading v0 makes it the most recently used, though v1 is the newest.
  const hit = await ctx.cache.get(ctx.script, fingerprint('v0'));
  assert.ok(hit);
  // A hit holds the entry's lock until it is applied or released.
  await hit.release();

  await ctx.cacheOutput('v2');
  assert.deepEqual(await ctx.entryHashes(), ['v0', 'v2'].map(hashOf).sort());
});

void test('a broken symlink in the cache folder does not wedge eviction', async () => {
  await using ctx = await setup(1);
  await ctx.cacheOutput('v0');
  await ctx.rig.symlink(
    'nowhere',
    pathlib.join(ctx.cacheDir, 'dangling'),
    'dir',
  );
  await ctx.cacheOutput('v1');
  assert.deepEqual(await ctx.entryHashes(), [hashOf('v1')]);
});

void test('a stray file in the cache folder is evicted like an entry', async () => {
  await using ctx = await setup(1);
  await ctx.cacheOutput('v0');
  await ctx.rig.write(pathlib.join(ctx.cacheDir, '.DS_Store'), '');
  await ctx.cacheOutput('v1');
  assert.deepEqual(await ctx.entryHashes(), [hashOf('v1')]);
});

void test('retains every entry when the limit is Infinity', async () => {
  await using ctx = await setup(Infinity);
  const names = ['v0', 'v1', 'v2', 'v3', 'v4'];
  for (const name of names) {
    await ctx.cacheOutput(name);
  }
  assert.deepEqual(await ctx.entryHashes(), names.map(hashOf).sort());
});

void test('a surviving entry can still be restored after an eviction', async () => {
  await using ctx = await setup(1);
  await ctx.cacheOutput('v0');
  await ctx.cacheOutput('v1');
  assert.deepEqual(await ctx.entryHashes(), [hashOf('v1')]);

  await ctx.rig.delete('output');
  const hit = await ctx.cache.get(ctx.script, fingerprint('v1'));
  assert.notEqual(hit, undefined);
  await hit!.apply();
  assert.equal(await ctx.rig.read('output'), 'v1');
});

void test('the entry just written is never the one evicted', async () => {
  await using ctx = await setup(1);
  await ctx.cacheOutput('v0');
  // A coarse mtime can make an older entry look at least as recent as the one
  // we just wrote. Ranking by mtime alone would then evict the new entry.
  await ctx.setRecency('v0', Date.now() / 1000 + 3600);
  await ctx.cacheOutput('v1');
  assert.deepEqual(await ctx.entryHashes(), [hashOf('v1')]);
});

void test('marking an entry used keeps it from being evicted', async () => {
  await using ctx = await setup(2);
  await ctx.cacheOutput('v0');
  await ctx.setRecency('v0', 1_000);
  await ctx.cacheOutput('v1');
  await ctx.setRecency('v1', 1_001);

  // What a fresh script does: nothing to restore, but this is its entry.
  await ctx.cache.markEntryRecentlyUsed(ctx.script, fingerprint('v0'));

  await ctx.cacheOutput('v2');
  assert.deepEqual(await ctx.entryHashes(), ['v0', 'v2'].map(hashOf).sort());
});

void test('marking an entry that does not exist is a no-op', async () => {
  await using ctx = await setup(2);
  await ctx.cache.markEntryRecentlyUsed(
    ctx.script,
    fingerprint('nothing-cached'),
  );
  assert.deepEqual(await ctx.entryHashes(), []);
});

void test('an evicted entry waits in the trash until it is swept', async () => {
  await using ctx = await setup(1);
  await ctx.cacheOutput('v0');
  await ctx.cacheOutput('v1');
  const trashed = await ctx.trashEntries();
  assert.equal(trashed.length, 1);
  // Renamed to something short and unique, not to anything derived from the
  // entry: a second eviction of the same fingerprint must not collide.
  assert.match(trashed[0]!, /^[0-9a-f]{16}$/);
  // Every file in the entry is renamed onto this path, so a tree that fit
  // before still fits. This is what keeps the Windows path limit out of it.
  assert.ok(
    pathlib.join(ctx.trashDir, trashed[0]!).length <
      pathlib.join(ctx.cacheDir, hashOf('v0')).length,
  );

  await ctx.cache.sweepTrash();
  assert.deepEqual(await ctx.trashEntries(), []);
  assert.deepEqual(await ctx.entryHashes(), [hashOf('v1')]);
});

void test('an unusable trash path degrades, it does not fail set', async () => {
  await using ctx = await setup(1);
  await ctx.cacheOutput('v0');
  // Nothing can be moved aside when the trash path is a file. Staying over the
  // limit is allowed; failing the script that just wrote an entry is not.
  await ctx.rig.write(pathlib.join('.wireit', 'trash'), '');

  await ctx.cacheOutput('v1');
  assert.deepEqual(await ctx.entryHashes(), ['v0', 'v1'].map(hashOf).sort());

  await ctx.cache.sweepTrash();
});

void test('sweeping a cache that has evicted nothing is a no-op', async () => {
  await using ctx = await setup(2);
  await ctx.cacheOutput('v0');
  await ctx.cache.sweepTrash();
  assert.deepEqual(await ctx.entryHashes(), [hashOf('v0')]);
});

void test('two caches sweeping the same trash at once is not an error', async () => {
  await using ctx = await setup(1);
  await ctx.cacheOutput('v0');
  await ctx.cacheOutput('v1');
  assert.equal((await ctx.trashEntries()).length, 1);

  // Two Wireit processes in one package: both list the same entries, and the
  // one that loses the race must tolerate them being gone.
  const other = new LocalCache(1);
  await other.markEntryRecentlyUsed(ctx.script, fingerprint('v1'));
  await Promise.all([ctx.cache.sweepTrash(), other.sweepTrash()]);
  assert.deepEqual(await ctx.trashEntries(), []);
});

void test('sweeping a symlinked entry does not delete its target', async () => {
  await using ctx = await setup(1);
  await ctx.rig.mkdir('elsewhere');
  await ctx.rig.write({'elsewhere/keep-me': 'precious'});
  await ctx.cacheOutput('v0');
  // A symlink out of the cache folder must be unlinked, never followed.
  await ctx.rig.symlink(
    ctx.rig.resolve('elsewhere'),
    pathlib.join(ctx.cacheDir, 'link'),
    'dir',
  );

  await ctx.cacheOutput('v1');
  // The link and the older entry, so the sweep really does handle a symlink.
  assert.equal((await ctx.trashEntries()).length, 2);

  await ctx.cache.sweepTrash();
  assert.deepEqual(await ctx.trashEntries(), []);
  assert.equal(await ctx.rig.read('elsewhere/keep-me'), 'precious');
});

void test('an aborted sweep leaves the trash for the next run', async () => {
  await using ctx = await setup(1);
  await ctx.cacheOutput('v0');
  await ctx.cacheOutput('v1');
  assert.equal((await ctx.trashEntries()).length, 1);

  await ctx.cache.sweepTrash({signal: AbortSignal.abort()});
  assert.equal((await ctx.trashEntries()).length, 1);

  await ctx.cache.sweepTrash();
  assert.deepEqual(await ctx.trashEntries(), []);
});

/**
 * Makes packages "pkg0", "pkg1", and so on, each with one entry of 5 files in
 * its trash, and makes their trash part of the cache's next sweep.
 */
async function addPackagesWithTrash(
  ctx: Awaited<ReturnType<typeof setup>>,
  numPackages: number,
): Promise<string[]> {
  const packages = [];
  for (let p = 0; p < numPackages; p++) {
    const pkg = `pkg${p}`;
    packages.push(pkg);
    // More files than the limit, so that each package alone could fill it.
    for (let i = 0; i < 5; i++) {
      await ctx.rig.write(
        pathlib.join(pkg, '.wireit', 'trash', 'entry', `f${i}`),
        '',
      );
    }
    // A cache hit makes the package's trash part of the sweep.
    await ctx.cache.markEntryRecentlyUsed(
      {packageDir: ctx.rig.resolve(pkg), name: SCRIPT_NAME},
      fingerprint('v0'),
    );
  }
  return packages;
}

/**
 * Starts a background sweep while the gate holds its calls, and returns how
 * many calls started before the held ones returned.
 */
async function numCallsStartedWhileHeld(
  ctx: Awaited<ReturnType<typeof setup>>,
  gate: FsGate,
): Promise<number> {
  const sweep = ctx.cache.sweepTrash({background: true});
  await gate.firstCall;
  // Give any further calls time to start, as they would without the limit.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const numCalls = gate.numCalls;
  gate.release();
  assert.deepEqual(await sweep, []);
  return numCalls;
}

void test('a background sweep keeps at most 4 deletions in flight across packages', async () => {
  await using ctx = await setup(1);
  const packages = await addPackagesWithTrash(ctx, 3);
  using gate = new FsGate({
    functions: ['rmdir', 'unlink'],
    path: /[\\/]\.wireit[\\/]trash[\\/]entry[\\/]/,
  });
  assert.equal(await numCallsStartedWhileHeld(ctx, gate), 4);
  for (const pkg of packages) {
    assert.equal(
      await ctx.rig.exists(pathlib.join(pkg, '.wireit', 'trash')),
      false,
    );
  }
});

void test('a background sweep lists at most 4 trash folders at once', async () => {
  await using ctx = await setup(1);
  await addPackagesWithTrash(ctx, 5);
  using gate = new FsGate({
    functions: ['readdir'],
    path: /[\\/]\.wireit[\\/]trash$/,
  });
  assert.equal(await numCallsStartedWhileHeld(ctx, gate), 4);
});

/** Evicts an entry, then sweeps while every delete in the trash fails. */
async function sweepWithDeletesFailing(code: string): Promise<string[]> {
  await using ctx = await setup(1);
  await ctx.cacheOutput('v0');
  await ctx.cacheOutput('v1');
  using _gate = new FsGate({
    functions: ['rm', 'rmdir', 'unlink'],
    path: /[\\/]\.wireit[\\/]trash[\\/]/,
    failWith: code,
  });
  return await ctx.cache.sweepTrash();
}

void test('warns about an entry the sweep cannot delete', async () => {
  const messages = await sweepWithDeletesFailing('EBUSY');
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /Could not delete .*EBUSY/);
  // Windows reports EBUSY while another program has a file open.
  assert.match(messages[0]!, /close any program that might be using it/);
});

void test('suggests closing programs only for an error they could cause', async () => {
  const messages = await sweepWithDeletesFailing('EACCES');
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /Could not delete .*EACCES/);
  assert.doesNotMatch(messages[0]!, /close any program/);
});

void test('get returns undefined for an evicted entry', async () => {
  await using ctx = await setup(1);
  await ctx.cacheOutput('v0');
  await ctx.cacheOutput('v1');
  assert.equal(await ctx.cache.get(ctx.script, fingerprint('v0')), undefined);
});

void test('a write that fails leaves no entry, and deletes its temp copy', async () => {
  await using ctx = await setup(1);
  await ctx.rig.write({output: 'v0'});
  {
    using _gate = new FsGate({
      functions: ['copyFile'],
      path: /[\\/]output$/,
      failWith: 'ENOSPC',
    });
    await assert.rejects(
      ctx.cache.set(ctx.script, fingerprint('v0'), [ctx.outputEntry]),
      {code: 'ENOSPC'},
    );
  }
  assert.deepEqual(await ctx.entryHashes(), []);
  assert.deepEqual(await ctx.tempEntries(), []);
  assert.deepEqual(await ctx.trashEntries(), []);

  await ctx.cacheOutput('v0');
  assert.deepEqual(await ctx.entryHashes(), [hashOf('v0')]);
});

for (const shareWorktrees of [false, true]) {
  void test(`a second set of an empty output is a hit (shareWorktrees: ${shareWorktrees})`, async () => {
    await using ctx = await setup(10, shareWorktrees);
    // Stop the worktree walk at this temp dir, including when the checkout
    // running the test is itself a linked worktree.
    await ctx.rig.mkdir('.git');
    assert.equal(await ctx.cache.set(ctx.script, fingerprint('v0'), []), true);
    assert.equal(await ctx.cache.set(ctx.script, fingerprint('v0'), []), true);
    assert.deepEqual(await ctx.entryHashes(), [hashOf('v0')]);
  });

  void test(`a second set of the same entry is a hit (shareWorktrees: ${shareWorktrees})`, async () => {
    await using ctx = await setup(10, shareWorktrees);
    // Stop the worktree walk at this temp dir, including when the checkout
    // running the test is itself a linked worktree.
    await ctx.rig.mkdir('.git');
    await ctx.cacheOutput('v0');
    await ctx.cacheOutput('v0');
    assert.deepEqual(await ctx.entryHashes(), [hashOf('v0')]);
  });
}

for (const shareWorktrees of [false, true]) {
  void test(`only temp leftovers over an hour old are trashed (shareWorktrees: ${shareWorktrees})`, async () => {
    await using ctx = await setup(10, shareWorktrees);
    // Stop the worktree walk at this temp dir, including when the checkout
    // running the test is itself a linked worktree.
    await ctx.rig.mkdir('.git');
    const tempDir = pathlib.join(getScriptDataDir(ctx.script), 'temp');
    await fs.mkdir(pathlib.join(tempDir, 'fresh'), {recursive: true});
    await fs.mkdir(pathlib.join(tempDir, 'old'), {recursive: true});
    const ancient = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(pathlib.join(tempDir, 'old'), ancient, ancient);
    await ctx.cacheOutput('v0');
    // The fresh folder may be another worktree's save in progress; the old one
    // is an aborted save.
    assert.deepEqual(await ctx.tempEntries(), ['fresh']);
  });

  void test(`eviction skips an entry whose lock is held (shareWorktrees: ${shareWorktrees})`, async () => {
    await using ctx = await setup(2, shareWorktrees);
    // Stop the worktree walk at this temp dir, including when the checkout
    // running the test is itself a linked worktree.
    await ctx.rig.mkdir('.git');
    await ctx.cacheOutput('v0');
    await ctx.setRecency('v0', 1_000);
    await ctx.cacheOutput('v1');
    await ctx.setRecency('v1', 1_001);

    // Another worktree is restoring v0.
    const restoring = await new LocalCache(10, {shareWorktrees}).get(
      ctx.script,
      fingerprint('v0'),
    );
    assert.ok(restoring);
    await ctx.setRecency('v0', 1_000);
    try {
      await ctx.cacheOutput('v2');
      // v0 is oldest but locked, so the next oldest (v1) goes instead. v2 is
      // never evicted, as the entry just written.
      assert.deepEqual(
        await ctx.entryHashes(),
        ['v0', 'v2'].map(hashOf).sort(),
      );
    } finally {
      await restoring.release();
    }

    await ctx.cacheOutput('v3');
    assert.deepEqual(await ctx.entryHashes(), ['v2', 'v3'].map(hashOf).sort());
  });
}

/**
 * Returns {@link promise}, but rejects after 5 seconds. A call that waits for a
 * held lock does not finish in that time.
 */
const soon = <T>(promise: Promise<T>): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Timed out')), 5000).unref();
    }),
  ]);

/** Caches an empty output. This runs eviction without writing a file. */
const cacheEmpty = (
  ctx: {cache: LocalCache; script: ScriptReference},
  name: string,
) => ctx.cache.set(ctx.script, fingerprint(name), []);

void test('shared cache hit holds its lock through restore', async () => {
  await using ctx = await setup(1, true);
  // Stop the worktree walk at this temp dir, including when the checkout
  // running the test is itself a linked worktree.
  await ctx.rig.mkdir('.git');
  await ctx.cacheOutput('v0');
  const hit = await ctx.cache.get(ctx.script, fingerprint('v0'));
  assert.ok(hit);
  await ctx.rig.delete('output');

  {
    using gate = new FsGate({
      functions: ['copyFile'],
      path: /[\\/]cache[\\/]/,
    });
    const restore = hit.apply();
    await gate.firstCall;
    // This write puts the folder over its limit of 1. v0 stays because it is
    // being restored.
    await cacheEmpty(ctx, 'v1');
    assert.deepEqual(await ctx.entryHashes(), ['v0', 'v1'].map(hashOf).sort());
    gate.release();
    await restore;
  }
  assert.equal(await ctx.rig.read('output'), 'v0');

  await cacheEmpty(ctx, 'v2');
  assert.deepEqual(await ctx.entryHashes(), [hashOf('v2')]);
});

void test('an abandoned shared cache hit releases its lock', async () => {
  await using ctx = await setup(1, true);
  // Stop the worktree walk at this temp dir, including when the checkout
  // running the test is itself a linked worktree.
  await ctx.rig.mkdir('.git');
  await ctx.cacheOutput('v0');
  const hit = await ctx.cache.get(ctx.script, fingerprint('v0'));
  assert.ok(hit);

  // StandardScriptExecution releases a hit in its finally block when it
  // cancels or fails before apply.
  await hit.release();
  await cacheEmpty(ctx, 'v1');
  assert.deepEqual(await ctx.entryHashes(), [hashOf('v1')]);
});

void test('a failed shared restore releases its lock', async () => {
  await using ctx = await setup(1, true);
  // Stop the worktree walk at this temp dir, including when the checkout
  // running the test is itself a linked worktree.
  await ctx.rig.mkdir('.git');
  await ctx.cacheOutput('v0');
  const hit = await ctx.cache.get(ctx.script, fingerprint('v0'));
  assert.ok(hit);

  await ctx.rig.delete('output');
  {
    using _gate = new FsGate({
      functions: ['copyFile'],
      path: /[\\/]cache[\\/]/,
      failWith: 'EIO',
    });
    await assert.rejects(hit.apply(), {code: 'EIO'});
  }
  await cacheEmpty(ctx, 'v1');
  assert.deepEqual(await ctx.entryHashes(), [hashOf('v1')]);
});

void test('two worktrees restore the same entry at once', async () => {
  await using ctx = await setup(10, true);
  // Stop the worktree walk at this temp dir, including when the checkout
  // running the test is itself a linked worktree.
  await ctx.rig.mkdir('.git');
  await ctx.cacheOutput('v0');
  const first = await ctx.cache.get(ctx.script, fingerprint('v0'));
  assert.ok(first);
  try {
    const second = await soon(
      new LocalCache(10, {shareWorktrees: true}).get(
        ctx.script,
        fingerprint('v0'),
      ),
    );
    assert.ok(second);
    const lockNames = await readdirIfExists(
      pathlib.join(getScriptDataDir(ctx.script), 'cache-locks', hashOf('v0')),
    );
    assert.equal(lockNames.length, 2);
    for (const name of lockNames) {
      assert.match(name, /^restore-[0-9a-f]{16}\.lock$/);
    }
    await ctx.rig.delete('output');
    await second.apply();
    assert.equal(await ctx.rig.read('output'), 'v0');
  } finally {
    await first.release();
  }
});

void test('a restore waits for an eviction of its entry in progress', async () => {
  await using ctx = await setup(10, true);
  // Stop the worktree walk at this temp dir, including when the checkout
  // running the test is itself a linked worktree.
  await ctx.rig.mkdir('.git');
  await ctx.cacheOutput('v0');
  const lockDir = pathlib.join(
    getScriptDataDir(ctx.script),
    'cache-locks',
    hashOf('v0'),
  );
  await fs.mkdir(lockDir, {recursive: true});
  const releaseEviction = await lockEntry(pathlib.join(lockDir, 'evict'));

  let settled = false;
  const get = ctx.cache.get(ctx.script, fingerprint('v0')).finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(settled, false);

  // Finish the eviction by hand.
  await fs.rm(pathlib.join(ctx.cacheDir, hashOf('v0')), {recursive: true});
  await releaseEviction();
  assert.equal(await soon(get), undefined);
});

for (const shareWorktrees of [false, true]) {
  void test(`a lookup that misses takes no lock (shareWorktrees: ${shareWorktrees})`, async () => {
    await using ctx = await setup(10, shareWorktrees);
    // Stop the worktree walk at this temp dir, including when the checkout
    // running the test is itself a linked worktree.
    await ctx.rig.mkdir('.git');
    assert.equal(await ctx.cache.get(ctx.script, fingerprint('v0')), undefined);
    assert.deepEqual(
      await readdirIfExists(
        pathlib.join(getScriptDataDir(ctx.script), 'cache-locks'),
      ),
      [],
    );
  });

  void test(`a hit restores from a cache folder that cannot be written (shareWorktrees: ${shareWorktrees})`, async () => {
    await using ctx = await setup(10, shareWorktrees);
    // Stop the worktree walk at this temp dir, including when the checkout
    // running the test is itself a linked worktree.
    await ctx.rig.mkdir('.git');
    await ctx.cacheOutput('v0');
    await ctx.rig.delete('output');
    // The lock folder cannot be created, as on a read-only mount.
    using _gate = new FsGate({
      functions: ['mkdir'],
      path: /[\\/]cache-locks/,
      failWith: 'EACCES',
    });
    const hit = await ctx.cache.get(ctx.script, fingerprint('v0'));
    assert.ok(hit);
    await hit.apply();
    assert.equal(await ctx.rig.read('output'), 'v0');
  });
}

/**
 * Creates a git repo in "main" and linked worktrees in "linked" and "linked2".
 */
async function addWorktrees(
  rig: FilesystemTestRig,
): Promise<{main: string; linked: string; linked2: string}> {
  const main = rig.resolve('main');
  const linked = rig.resolve('linked');
  const linked2 = rig.resolve('linked2');
  await rig.mkdir('main');
  initRepo(main);
  await rig.write(pathlib.join('main', 'package.json'), '{}');
  git(main, ['add', '.']);
  git(main, ['commit', '-m', 'init']);
  git(main, ['worktree', 'add', linked, '-b', 'other']);
  git(main, ['worktree', 'add', linked2, '-b', 'other2']);
  return {main, linked, linked2};
}

/** Returns a file entry in the form that {@link LocalCache.set} takes. */
const fileEntry = (path: string) =>
  ({
    path,
    dirent: {
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    },
  }) as AbsoluteEntry;

void test('the over-limit reminder names the shared cache folder', async () => {
  await using rig = await FilesystemTestRig.setup();
  const {main, linked} = await addWorktrees(rig);
  const mainCacheDir = pathlib.join(
    getScriptDataDir({packageDir: main, name: SCRIPT_NAME}),
    'cache',
  );
  // Fill the main worktree's cache with old entries. A Wireit version without
  // a limit could leave this many.
  for (const name of ['v0', 'v1', 'v2', 'v3', 'v4', 'v5']) {
    await fs.mkdir(pathlib.join(mainCacheDir, hashOf(name)), {recursive: true});
  }

  const cache = new LocalCache(1, {shareWorktrees: true});
  await rig.write(pathlib.join('linked', 'output'), 'n0');
  await cache.set({packageDir: linked, name: SCRIPT_NAME}, fingerprint('n0'), [
    fileEntry(pathlib.join(linked, 'output')),
  ]);

  // The message must name the main worktree's folder. The linked worktree has
  // no cache of its own.
  const messages = await cache.sweepTrash();
  assert.equal(messages.length, 1);
  const mainDataDir = pathlib.join(await fs.realpath(main), '.wireit');
  assert.ok(messages[0]!.includes(mainDataDir), messages[0]);
  assert.ok(!messages[0]!.includes(linked), messages[0]);
});

void test('restoring and evicting entries leave no lock files behind', async () => {
  await using ctx = await setup(1);
  await ctx.cacheOutput('v0');
  const hit = await ctx.cache.get(ctx.script, fingerprint('v0'));
  assert.ok(hit);
  await ctx.rig.delete('output');
  await hit.apply();
  // This write evicts v0.
  await ctx.cacheOutput('v1');
  assert.deepEqual(await ctx.entryHashes(), [hashOf('v1')]);

  assert.deepEqual(
    await readdirIfExists(
      pathlib.join(getScriptDataDir(ctx.script), 'cache-locks'),
    ),
    [],
  );
});

// A linked worktree with WIREIT_CACHE_WORKTREES stores its cache in the main
// worktree's cache folder. It does this even when the main worktree does not
// set the flag. So two runs share a folder when each run is either in the
// main worktree or in a linked worktree with the flag. Each test below puts a
// run with the flag in a linked worktree. It puts a run without the flag in
// the main worktree. The tests try every combination.

/** The parts of a Wireit run that the cache uses. */
interface Run {
  cache: LocalCache;
  script: ScriptReference;
  /** The package folder in the run's worktree. */
  dir: string;
}

/**
 * Creates a run. A run without the flag is in the main worktree. A run with
 * the flag is in the linked worktree {@link linked}.
 */
const run = (
  worktrees: {main: string},
  shareWorktrees: boolean,
  linked: string,
  maxEntries: number,
): Run => {
  const dir = shareWorktrees ? linked : worktrees.main;
  return {
    cache: new LocalCache(maxEntries, {shareWorktrees}),
    script: {packageDir: dir, name: SCRIPT_NAME},
    dir,
  };
};

const onOff = (flag: boolean) => (flag ? 'on' : 'off');

// A fingerprint from Fingerprint.fromString has the same entry name with or
// without the flag. A real fingerprint does too when the script has no input
// files and no dependencies.
for (const first of [false, true]) {
  for (const second of [false, true]) {
    for (const empty of [false, true]) {
      void test(`a second save of an entry is a hit (flag ${onOff(first)} in the first run, ${onOff(second)} in the second run, ${empty ? 'empty output' : 'one file'})`, async () => {
        await using rig = await FilesystemTestRig.setup();
        const worktrees = await addWorktrees(rig);
        for (const r of [
          run(worktrees, first, worktrees.linked, 10),
          run(worktrees, second, worktrees.linked2, 10),
        ]) {
          const output = pathlib.join(r.dir, 'output');
          await fs.writeFile(output, 'v0');
          assert.equal(
            await r.cache.set(
              r.script,
              fingerprint('v0'),
              empty ? [] : [fileEntry(output)],
            ),
            true,
          );
        }
      });
    }
  }
}

for (const restoring of [false, true]) {
  for (const evicting of [false, true]) {
    void test(`an entry being restored is not evicted (flag ${onOff(restoring)} in the restoring run, ${onOff(evicting)} in the evicting run)`, async () => {
      await using rig = await FilesystemTestRig.setup();
      const worktrees = await addWorktrees(rig);
      const restorer = run(worktrees, restoring, worktrees.linked, 10);
      const evictor = run(worktrees, evicting, worktrees.linked2, 1);

      const output = pathlib.join(restorer.dir, 'output');
      await fs.writeFile(output, 'v0');
      await restorer.cache.set(restorer.script, fingerprint('v0'), [
        fileEntry(output),
      ]);
      const hit = await restorer.cache.get(restorer.script, fingerprint('v0'));
      assert.ok(hit);
      await fs.rm(output);

      // This run saves an empty output, so it writes no file. A file could
      // collide with the restore when both runs are in the main worktree. Its
      // limit is 1, so it would evict v0, the only other entry.
      await evictor.cache.set(evictor.script, fingerprint('v1'), []);

      await hit.apply();
      assert.equal(await fs.readFile(output, 'utf8'), 'v0');
    });
  }
}

for (const saving of [false, true]) {
  for (const cleaning of [false, true]) {
    void test(`a save in progress is not trashed (flag ${onOff(saving)} in the saving run, ${onOff(cleaning)} in the cleaning run)`, async () => {
      await using rig = await FilesystemTestRig.setup();
      const worktrees = await addWorktrees(rig);
      const saver = run(worktrees, saving, worktrees.linked, 10);
      const cleaner = run(worktrees, cleaning, worktrees.linked2, 10);

      // The two runs use different file names. Then the gate pauses only the
      // saving run's copy, even when both runs are in the main worktree.
      const saved = pathlib.join(saver.dir, 'saved');
      const cleanerOutput = pathlib.join(cleaner.dir, 'output');
      await fs.writeFile(saved, 'v0');
      await fs.writeFile(cleanerOutput, 'v1');
      {
        using gate = new FsGate({
          functions: ['copyFile'],
          path: /[\\/]saved$/,
        });
        const save = saver.cache.set(saver.script, fingerprint('v0'), [
          fileEntry(saved),
        ]);
        await gate.firstCall;
        // This write cleans up the script's temp folder. The saving run's
        // copy is still in progress there.
        await cleaner.cache.set(cleaner.script, fingerprint('v1'), [
          fileEntry(cleanerOutput),
        ]);
        gate.release();
        assert.equal(await save, true);
      }

      await fs.rm(saved);
      const hit = await saver.cache.get(saver.script, fingerprint('v0'));
      assert.ok(hit);
      await hit.apply();
      assert.equal(await fs.readFile(saved, 'utf8'), 'v0');
    });
  }
}

void test('a linked worktree finds its shared cache folder once per run', async () => {
  await using rig = await FilesystemTestRig.setup();
  const {linked} = await addWorktrees(rig);
  const linkedScript = {packageDir: linked, name: SCRIPT_NAME};
  const cache = new LocalCache(10, {shareWorktrees: true});
  await rig.write(pathlib.join('linked', 'output'), 'v0');
  await cache.set(linkedScript, fingerprint('v0'), [
    fileEntry(pathlib.join(linked, 'output')),
  ]);

  // Hide the linked worktree's ".git" file. A new lookup would now treat the
  // worktree as a separate checkout.
  await fs.rename(
    pathlib.join(linked, '.git'),
    pathlib.join(linked, '.git-hidden'),
  );
  // Stop a new lookup's walk at the rig. The checkout that runs the test may
  // itself be a linked worktree.
  await rig.mkdir('.git');
  const hit = await cache.get(linkedScript, fingerprint('v0'));
  assert.ok(hit);
  await hit.release();
});

void test('a package that only a linked worktree has keeps its own cache', async () => {
  await using rig = await FilesystemTestRig.setup();
  const {linked} = await addWorktrees(rig);
  // Only the linked worktree's branch has this package.
  const pkg = pathlib.join(linked, 'packages', 'bar');
  await rig.write(
    pathlib.join('linked', 'packages', 'bar', 'package.json'),
    '{}',
  );
  await rig.write(pathlib.join('linked', 'packages', 'bar', 'output'), 'v0');
  const script = {packageDir: pkg, name: SCRIPT_NAME};
  const cache = new LocalCache(10, {shareWorktrees: true});
  await cache.set(script, fingerprint('v0'), [
    fileEntry(pathlib.join(pkg, 'output')),
  ]);

  const cacheDir = pathlib.join(getScriptDataDir(script), 'cache');
  assert.deepEqual(await readdirIfExists(cacheDir), [hashOf('v0')]);
  assert.equal(await rig.exists(pathlib.join('main', 'packages')), false);
});

void test('linked worktree restores from the main worktree local cache', async () => {
  await using rig = await FilesystemTestRig.setup();
  const main = rig.resolve('main');
  const linked = rig.resolve('linked');
  await rig.mkdir('main');
  initRepo(main);
  await rig.write(pathlib.join('main', 'package.json'), '{}');
  git(main, ['add', '.']);
  git(main, ['commit', '-m', 'init']);
  git(main, ['worktree', 'add', linked, '-b', 'other']);

  const mainScript = {packageDir: main, name: SCRIPT_NAME};
  const linkedScript = {packageDir: linked, name: SCRIPT_NAME};
  const cache = new LocalCache(10, {shareWorktrees: true});
  const outputEntry = {
    path: pathlib.join(main, 'output'),
    dirent: {
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    },
  } as AbsoluteEntry;
  await rig.write(pathlib.join('main', 'output'), 'from-main');
  assert.equal(
    await cache.set(mainScript, fingerprint('v0'), [outputEntry]),
    true,
  );

  const linkedCacheDir = pathlib.join(getScriptDataDir(linkedScript), 'cache');
  await assert.rejects(fs.readdir(linkedCacheDir), {code: 'ENOENT'});

  const hit = await cache.get(linkedScript, fingerprint('v0'));
  assert.ok(hit);
  await hit.apply();
  assert.equal(await rig.read(pathlib.join('linked', 'output')), 'from-main');
});
