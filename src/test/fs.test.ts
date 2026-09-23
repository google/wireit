/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {rmTree, Semaphore} from '../util/fs.js';
import {test} from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs/promises';
import * as pathlib from 'path';
import {FilesystemTestRig} from './util/filesystem-test-rig.js';
import {FsGate} from './util/fs-gate.js';

async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void test('Semaphore restricts resource access', async () => {
  const semaphore = new Semaphore(1);
  const reservation1 = await semaphore.reserve();
  const reservation2Promise = semaphore.reserve();
  let hasResolved = false;
  void reservation2Promise.then(() => {
    hasResolved = true;
  });
  // Wait a bit to make sure the promise has had a chance to resolve.
  await wait(100);
  // The semaphore doesn't let the second reservation happen yet, it would
  // be over budget.
  assert.strictEqual(hasResolved, false);
  reservation1[Symbol.dispose]();
  // Now it can happen.
  await reservation2Promise;
  assert.strictEqual(hasResolved, true);
});

void test('Semaphore reservation happens immediately when not under contention', async () => {
  const semaphore = new Semaphore(3);
  await semaphore.reserve();
  await semaphore.reserve();
  await semaphore.reserve();
  // If the test finishes, then we were able to reserve three slots.
});

/** Writes `numFiles` empty files into the folder "tree", split over two levels. */
async function writeTree(rig: FilesystemTestRig, numFiles: number) {
  const files: Record<string, string> = {};
  for (let i = 0; i < numFiles; i++) {
    files[pathlib.join('tree', `dir${i % 10}`, `file${i}`)] = '';
  }
  await rig.write(files);
}

/** Matches every path inside the folder "tree". */
const treePattern = (rig: FilesystemTestRig) =>
  new RegExp(
    '^' +
      rig.resolve('tree').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      '[\\\\/]',
  );

async function countFiles(rig: FilesystemTestRig): Promise<number> {
  let count = 0;
  for (let i = 0; i < 10; i++) {
    const dir = pathlib.join('tree', `dir${i}`);
    if (await rig.exists(dir)) {
      count += (await fs.readdir(rig.resolve(dir))).length;
    }
  }
  return count;
}

void test('rmTree deletes a folder tree', async () => {
  const rig = new FilesystemTestRig();
  await rig.setup();
  try {
    await writeTree(rig, 20);
    await rmTree(rig.resolve('tree'));
    assert.equal(await rig.exists('tree'), false);
    // A missing path is not an error, as with fs.rm and force.
    await rmTree(rig.resolve('tree'));
  } finally {
    await rig.cleanup();
  }
});

void test('rmTree stops when the signal aborts', async () => {
  const rig = new FilesystemTestRig();
  await rig.setup();
  try {
    // More files than the default open file budget of 200, so that some are
    // still waiting for a slot when the signal aborts.
    const numFiles = 300;
    await writeTree(rig, numFiles);
    using gate = new FsGate({
      functions: ['rmdir', 'unlink'],
      path: treePattern(rig),
    });
    const controller = new AbortController();
    const removal = rmTree(rig.resolve('tree'), {signal: controller.signal});
    let settled = false;
    void removal.catch(() => {}).finally(() => (settled = true));

    await gate.firstCall;
    controller.abort();
    const numCalls = gate.numCalls;
    // rmTree waits for the held deletions before it settles.
    await wait(50);
    assert.equal(settled, false);

    gate.release();
    await assert.rejects(removal, {name: 'AbortError'});
    // No deletion started after the abort.
    assert.equal(gate.numCalls, numCalls);
    assert.ok(numCalls < numFiles);
    assert.equal(await countFiles(rig), numFiles - numCalls);
  } finally {
    await rig.cleanup();
  }
});

void test('rmTree keeps at most maxConcurrent calls in flight', async () => {
  const rig = new FilesystemTestRig();
  await rig.setup();
  try {
    await writeTree(rig, 20);
    using gate = new FsGate({
      functions: ['rmdir', 'unlink'],
      path: treePattern(rig),
    });
    const removal = rmTree(rig.resolve('tree'), {maxConcurrent: 3});
    await gate.firstCall;
    // Give any further calls time to start, as they would without the limit.
    await wait(50);
    assert.equal(gate.numCalls, 3);
    gate.release();
    await removal;
    assert.equal(await rig.exists('tree'), false);
  } finally {
    await rig.cleanup();
  }
});

void test('rmTree falls back to fs.rm when unlink fails', async () => {
  const rig = new FilesystemTestRig();
  await rig.setup();
  try {
    await writeTree(rig, 1);
    // unlink fails like this on Windows for some files, such as read-only
    // ones, which fs.rm can still delete.
    using _unlink = new FsGate({
      functions: ['unlink'],
      path: treePattern(rig),
      failWith: 'EPERM',
    });
    await rmTree(rig.resolve('tree'));
    assert.equal(await rig.exists('tree'), false);
  } finally {
    await rig.cleanup();
  }
});
