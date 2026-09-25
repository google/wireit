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
import {LocalCache} from '../caching/local-cache.js';
import {Fingerprint} from '../fingerprint.js';
import {getScriptDataDir} from '../util/script-data-dir.js';
import {FilesystemTestRig} from './util/filesystem-test-rig.js';
import {FsGate} from './util/fs-gate.js';

import type {AbsoluteEntry} from '../util/glob.js';
import type {FingerprintString} from '../fingerprint.js';
import type {ScriptReference} from '../config.js';

// Eviction of least recently used cache entries.
// https://github.com/google/wireit/issues/71

const SCRIPT_NAME = 'a';

async function setup(maxEntries: number): Promise<
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
  const cache = new LocalCache(maxEntries);
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
  assert.notEqual(
    await ctx.cache.get(ctx.script, fingerprint('v0')),
    undefined,
  );

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
