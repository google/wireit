/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {test} from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs/promises';
import * as pathlib from 'path';
import {getScriptDataDir} from '../util/script-data-dir.js';
import {IS_WINDOWS} from '../util/windows.js';
import {
  DEFAULT_TIMEOUT,
  pollUntil,
  rigTest,
  wait,
  waitForLog,
  withTimeout,
} from './util/rig-test.js';
import {gateWireitFs} from './util/wireit-fs-gate.js';
import {registerCommonCacheTests} from './cache-common.js';

import type {ExecResult, WireitTestRig} from './util/test-rig.js';
import type {WireitTestRigCommand} from './util/test-rig-command.js';

registerCommonCacheTests((...args) => void test(...args), 'local');

// The tests below run Wireit to check the local cache's entry limit and the
// deletion of evicted entries. local-cache.test.ts tests LocalCache directly.
// https://github.com/google/wireit/issues/71

const TRASH = pathlib.join('.wireit', 'trash');

/** Writes a package whose script "a" reads "input" and writes "output". */
async function writePackage(rig: WireitTestRig): Promise<WireitTestRigCommand> {
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
  return cmdA;
}

/**
 * Starts script "a" with `version` as its input, and has its command write
 * `version` to its output and exit. Returns once the command has exited, which
 * is before Wireit exits.
 */
async function startA(
  rig: WireitTestRig,
  cmdA: WireitTestRigCommand,
  version: string,
  args = '',
): Promise<ExecResult> {
  await rig.write({input: version});
  const exec = rig.exec(`npm run a ${args}`.trim());
  const inv = await cmdA.nextInvocation();
  await rig.write({output: version});
  inv.exit(0);
  // Wait for the command's socket to close, so that a signal sent to Wireit
  // later can't kill the command before it has received the exit message.
  await inv.closed;
  return exec;
}

/** The names of the entries in script "a"'s cache folder. */
async function cacheEntries(rig: WireitTestRig): Promise<string[]> {
  const cacheDir = pathlib.join(
    getScriptDataDir({packageDir: rig.resolve('.'), name: 'a'}),
    'cache',
  );
  return (await fs.readdir(cacheDir)).sort();
}

/** Writes entries into the trash, as an interrupted sweep leaves them. */
async function writeTrash(
  rig: WireitTestRig,
  numEntries: number,
  filesPerEntry: number,
): Promise<void> {
  for (let entry = 0; entry < numEntries; entry++) {
    const files: Record<string, string> = {};
    for (let file = 0; file < filesPerEntry; file++) {
      files[pathlib.join(TRASH, `entry${entry}`, `file${file}`)] = '';
    }
    await rig.write(files);
  }
}

/** The number of files in the trash, as written by {@link writeTrash}. */
async function countTrashFiles(rig: WireitTestRig): Promise<number> {
  const readdirIfExists = async (path: string) => {
    try {
      return await fs.readdir(rig.resolve(path));
    } catch (error) {
      if ((error as {code?: string}).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  };
  let count = 0;
  for (const entry of await readdirIfExists(TRASH)) {
    count += (await readdirIfExists(pathlib.join(TRASH, entry))).length;
  }
  return count;
}

async function assertNoTrash(rig: WireitTestRig): Promise<void> {
  assert.equal(await rig.exists(TRASH), false);
}

const TRASH_DELETIONS = {
  functions: ['rm', 'rmdir', 'unlink'],
  path: /[\\/]\.wireit[\\/]trash[\\/]/,
};

/**
 * Holds every deletion inside a trash folder, in the Wireit processes that
 * the rig starts from now on, until the test releases them.
 */
const holdTrashDeletions = (rig: WireitTestRig) =>
  gateWireitFs(rig, TRASH_DELETIONS);

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
      // The CLI sweeps the trash before it exits.
      await assert.rejects(
        fs.readdir(rig.resolve(pathlib.join('.wireit', 'trash'))),
        {
          code: 'ENOENT',
        },
      );
    },
    {env: {WIREIT_CACHE_MAX_ENTRIES: '2'}},
  ),
);

void test(
  'a cache from before the limit still hits, and later writes trim it',
  {timeout: DEFAULT_TIMEOUT},
  rigTest(async ({rig}) => {
    const cmdA = await writePackage(rig);
    // Versions before the limit kept every entry. The folder layout is the
    // same, so a cache filled with no limit is the one an upgrading user has.
    rig.env = {...rig.env, WIREIT_CACHE_MAX_ENTRIES: 'infinity'};
    for (const version of ['v0', 'v1', 'v2', 'v3', 'v4']) {
      assert.equal((await (await startA(rig, cmdA, version)).exit).code, 0);
    }
    assert.equal((await cacheEntries(rig)).length, 5);

    rig.env = {...rig.env, WIREIT_CACHE_MAX_ENTRIES: '2'};
    // An old entry is restored. A hit writes no entry, so nothing is evicted.
    await rig.write({input: 'v0'});
    assert.equal((await rig.exec('npm run a').exit).code, 0);
    assert.equal(cmdA.numInvocations, 5);
    assert.equal(await rig.read('output'), 'v0');
    assert.equal((await cacheEntries(rig)).length, 5);

    const sizes = [];
    for (const version of ['n0', 'n1', 'n2', 'n3']) {
      assert.equal((await (await startA(rig, cmdA, version)).exit).code, 0);
      sizes.push((await cacheEntries(rig)).length);
      await assertNoTrash(rig);
    }
    // Each write evicts at most two entries, so the folder shrinks by one
    // entry per write until it reaches the limit.
    assert.deepEqual(sizes, [4, 3, 2, 2]);
  }),
);

void test(
  'deletes a read-only file in the trash',
  {timeout: DEFAULT_TIMEOUT},
  rigTest(async ({rig}) => {
    // Windows won't delete a read-only file until the read-only attribute is
    // cleared. Linux and macOS check only the folder's permissions, so this
    // test can fail only on Windows.
    const cmdA = await writePackage(rig);
    await writeTrash(rig, 1, 1);
    await fs.chmod(rig.resolve(pathlib.join(TRASH, 'entry0', 'file0')), 0o444);
    assert.equal((await (await startA(rig, cmdA, 'v0')).exit).code, 0);
    await assertNoTrash(rig);
  }),
);

void test(
  'warns when an entry in the trash cannot be deleted',
  {timeout: DEFAULT_TIMEOUT},
  rigTest(async ({rig}) => {
    const cmdA = await writePackage(rig);
    await writeTrash(rig, 1, 1);
    // Deleting fails like this on Windows while another program has the file
    // open.
    await using _gate = await gateWireitFs(rig, {
      ...TRASH_DELETIONS,
      failWith: 'EBUSY',
    });
    const exec = await startA(rig, cmdA, 'v0');
    await waitForLog(exec, /Could not delete .*entry0.*EBUSY/);
    // The scripts succeeded, so the run does too.
    assert.equal((await exec.exit).code, 0);
    assert.equal(await countTrashFiles(rig), 1);

    // Once the entry can be deleted, the next run deletes it without a
    // warning.
    rig.env = {...rig.env, WIREIT_TEST_FS_GATE: undefined};
    const {code, stderr} = await rig.exec('npm run a').exit;
    assert.equal(code, 0);
    assert.doesNotMatch(stderr, /Could not delete/);
    await assertNoTrash(rig);
  }),
);

void test(
  'prints a notice while a slow sweep delays exit',
  {timeout: DEFAULT_TIMEOUT},
  rigTest(async ({rig}) => {
    const cmdA = await writePackage(rig);
    await writeTrash(rig, 1, 1);
    await using gate = await holdTrashDeletions(rig);
    const exec = await startA(rig, cmdA, 'v0');
    await gate.firstCall(exec);
    // Printed once the sweep has taken a second.
    await waitForLog(exec, /Deleting evicted cache entries\. Ctrl-C is safe/);
    await gate.release();
    assert.equal((await exec.exit).code, 0);
    await assertNoTrash(rig);
  }),
);

void test(
  'watch mode deletes evicted entries while it keeps watching',
  {timeout: DEFAULT_TIMEOUT},
  rigTest(
    async ({rig}) => {
      const cmdA = await writePackage(rig);
      const exec = await startA(rig, cmdA, 'v0', '--watch');
      await waitForLog(exec, /Ran 1 script and skipped 0/);
      const [firstEntry] = await cacheEntries(rig);

      // The second entry evicts the first.
      await rig.writeAtomic({input: 'v1'});
      const inv = await cmdA.nextInvocation();
      await rig.write({output: 'v1'});
      inv.exit(0);
      await inv.closed;
      // The trash doesn't exist until the eviction, so wait for that first.
      await pollUntil(
        'evicting the first entry',
        async () => !(await cacheEntries(rig)).includes(firstEntry!),
        exec,
      );
      await pollUntil(
        'deleting the trash',
        async () => !(await rig.exists(TRASH)),
        exec,
      );
      exec.kill();
      await exec.exit;
    },
    {env: {WIREIT_CACHE_MAX_ENTRIES: '1'}},
  ),
);

void test(
  'watch mode starts the next iteration while a sweep is still running',
  {timeout: DEFAULT_TIMEOUT},
  rigTest(
    async ({rig}) => {
      const cmdA = await writePackage(rig);
      await using gate = await holdTrashDeletions(rig);
      const exec = await startA(rig, cmdA, 'v0', '--watch');
      await waitForLog(exec, /Ran 1 script and skipped 0/);

      // The second iteration evicts the first entry, and the sweep that
      // follows is held.
      await rig.writeAtomic({input: 'v1'});
      let inv = await cmdA.nextInvocation();
      await rig.write({output: 'v1'});
      inv.exit(0);
      await inv.closed;
      await waitForLog(exec, /Ran 1 script and skipped 0/);
      await gate.firstCall(exec);

      // The third iteration runs while the sweep is still held.
      await rig.writeAtomic({input: 'v2'});
      inv = await withTimeout('the third iteration', cmdA.nextInvocation());
      await rig.write({output: 'v2'});
      inv.exit(0);
      await inv.closed;
      await waitForLog(exec, /Ran 1 script and skipped 0/);
      assert.ok(await rig.exists(TRASH));

      await gate.release();
      await pollUntil(
        'deleting the trash',
        async () => !(await rig.exists(TRASH)),
        exec,
      );
      exec.kill();
      await exec.exit;
    },
    {env: {WIREIT_CACHE_MAX_ENTRIES: '1'}},
  ),
);

void test(
  'watch mode sweeps one at a time, deleting at most 4 files at once',
  {timeout: DEFAULT_TIMEOUT},
  rigTest(
    async ({rig}) => {
      const cmdA = await writePackage(rig);
      await writeTrash(rig, 1, 20);
      await using gate = await holdTrashDeletions(rig);
      const exec = await startA(rig, cmdA, 'v0', '--watch');
      await waitForLog(exec, /Ran 1 script and skipped 0/);
      await gate.firstCall(exec);

      // The second iteration evicts the first entry while the sweep is held.
      // Its sweep waits for the first one, instead of starting on the same
      // trash beside it.
      await rig.writeAtomic({input: 'v1'});
      const inv = await withTimeout(
        'the second iteration',
        cmdA.nextInvocation(),
      );
      await rig.write({output: 'v1'});
      inv.exit(0);
      await inv.closed;
      await waitForLog(exec, /Ran 1 script and skipped 0/);
      // Give any further deletions time to start, as they would without
      // these limits.
      await wait(200);
      // Watch mode deletes at most 4 files at once, so that the next
      // iteration's file system calls don't wait behind many deletions.
      assert.equal(await gate.numCalls(), 4);

      // The first sweep finishes, then a second one deletes the entry that
      // the second iteration evicted.
      await gate.release();
      await pollUntil(
        'deleting the trash',
        async () => !(await rig.exists(TRASH)),
        exec,
      );
      exec.kill();
      await exec.exit;
    },
    {env: {WIREIT_CACHE_MAX_ENTRIES: '1'}},
  ),
);

const NUM_ENTRIES = 3;
const FILES_PER_ENTRY = 50;
const MAX_OPEN_FILES = 10;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  for (const watch of [false, true]) {
    void test(
      `${signal} stops a sweep${watch ? ' in watch mode' : ''} part way ` +
        'through an entry, and the next run finishes it',
      {
        // Windows has no signals. The test rig ends a process there with
        // "taskkill /f", which runs no SIGINT or SIGTERM handler. Node on
        // Windows raises SIGINT only for Ctrl-C typed into a console, and
        // never raises SIGTERM.
        skip: IS_WINDOWS,
        timeout: DEFAULT_TIMEOUT,
      },
      rigTest(async ({rig}) => {
        const cmdA = await writePackage(rig);
        await writeTrash(rig, NUM_ENTRIES, FILES_PER_ENTRY);
        rig.env = {...rig.env, WIREIT_MAX_OPEN_FILES: String(MAX_OPEN_FILES)};
        await using gate = await holdTrashDeletions(rig);
        const exec = await startA(rig, cmdA, 'v0', watch ? '--watch' : '');
        await gate.firstCall(exec);
        exec.kill(signal);
        await gate.signaled(exec);
        await gate.release();
        const {code, stderr} = await exec.exit;
        // Entries left by the signal are not failures.
        assert.doesNotMatch(stderr, /Could not delete/);
        // Ctrl-C ends watch mode normally. Otherwise the scripts succeeded,
        // but the sweep was cut short, so Wireit exits as an interrupted
        // process does: 130 for SIGINT, and 143 for SIGTERM.
        assert.equal(code, watch ? 0 : {SIGINT: 130, SIGTERM: 143}[signal]);
        // Only the deletions already running when the signal arrived finish.
        // At most MAX_OPEN_FILES run at once, so the entry being deleted is
        // left part way.
        assert.ok(
          (await countTrashFiles(rig)) >=
            NUM_ENTRIES * FILES_PER_ENTRY - MAX_OPEN_FILES,
        );

        // Fresh, so the command doesn't run, but the sweep does.
        assert.equal((await rig.exec('npm run a').exit).code, 0);
        assert.equal(cmdA.numInvocations, 1);
        await assertNoTrash(rig);
      }),
    );
  }
}
