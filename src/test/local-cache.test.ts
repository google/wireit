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
import {rigTest} from './util/rig-test.js';

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

  const entryHashes = async () => {
    try {
      return (await fs.readdir(cacheDir)).sort();
    } catch (error) {
      if ((error as {code?: string}).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  };

  const setRecency = async (name: string, secondsSinceEpoch: number) => {
    const when = new Date(secondsSinceEpoch * 1000);
    await fs.utimes(pathlib.join(cacheDir, hashOf(name)), when, when);
  };

  return {
    rig,
    cache,
    script,
    cacheDir,
    cacheOutput,
    entryHashes,
    setRecency,
    [Symbol.asyncDispose]: () => rig.cleanup(),
  };
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

void test('get returns undefined for an evicted entry', async () => {
  await using ctx = await setup(1);
  await ctx.cacheOutput('v0');
  await ctx.cacheOutput('v1');
  assert.equal(await ctx.cache.get(ctx.script, fingerprint('v0')), undefined);
});

void test(
  'WIREIT_CACHE_MAX_ENTRIES caps the cache directory end to end',
  rigTest(
    async ({rig}) => {
      const cmdA = await rig.newCommand();
      await rig.write({
        'package.json': {
          scripts: {a: 'wireit'},
          wireit: {
            a: {
              command: cmdA.command,
              files: ['input'],
              output: ['output'],
            },
          },
        },
      });

      for (const version of ['v0', 'v1', 'v2', 'v3', 'v4']) {
        await rig.write({input: version});
        const exec = rig.exec('npm run a');
        const inv = await cmdA.nextInvocation();
        await rig.write({output: version});
        inv.exit(0);
        assert.equal((await exec.exit).code, 0);
      }
      assert.equal(cmdA.numInvocations, 5);

      const cacheDir = pathlib.join(
        getScriptDataDir({packageDir: rig.resolve('.'), name: 'a'}),
        'cache',
      );
      assert.equal((await fs.readdir(cacheDir)).length, 2);
    },
    {env: {WIREIT_CACHE_MAX_ENTRIES: '2'}},
  ),
);
