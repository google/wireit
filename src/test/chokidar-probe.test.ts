/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Standalone probe of chokidar 4 behavior across platforms.
 *
 * These tests are designed to surface cross-platform differences in how
 * chokidar 4 (which uses Node's fs.watch, not fsevents) emits events for
 * directories vs files, particularly when the `ignored` callback must return
 * false for directories to allow recursion.
 *
 * The fix in chokidar-with-globs.ts patches `watcher.emit` to suppress
 * spurious directory events. These tests validate whether that's actually
 * needed and correct on each platform.
 */

import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {describe, test, afterEach} from 'node:test';
import chokidar, {type FSWatcher as ChokidarFSWatcher} from 'chokidar';

interface RecordedEvent {
  event: string;
  path: string;
  timestamp: number;
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'chokidar-probe-'));
}

function collectEvents(
  watcher: ChokidarFSWatcher,
  events: RecordedEvent[],
): void {
  const record = (event: string) => (filePath: string) => {
    events.push({event, path: filePath, timestamp: Date.now()});
  };
  watcher.on('add', record('add'));
  watcher.on('addDir', record('addDir'));
  watcher.on('change', record('change'));
  watcher.on('unlink', record('unlink'));
  watcher.on('unlinkDir', record('unlinkDir'));
  watcher.on('all', (eventName: string, filePath: string) => {
    events.push({
      event: `all:${eventName}`,
      path: filePath,
      timestamp: Date.now(),
    });
  });
}

function waitForReady(watcher: ChokidarFSWatcher): Promise<void> {
  return new Promise((resolve) => watcher.once('ready', resolve));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const activeWatchers: ChokidarFSWatcher[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const w of activeWatchers) {
    await w.close();
  }
  activeWatchers.length = 0;
  for (const d of tempDirs) {
    await fs.rm(d, {recursive: true, force: true});
  }
  tempDirs.length = 0;
});

describe('chokidar 4 platform behavior probes', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // Probe 1: Does chokidar emit addDir events for directories that the
  // `ignored` callback returns false for?
  //
  // Setup: Watch a directory with an `ignored` callback that returns false
  // for all directories (simulating the glob recursion requirement) but
  // true for all files. After ready, create a new subdirectory. Do we get
  // an addDir event for it?
  // ──────────────────────────────────────────────────────────────────────────
  test('Probe 1: addDir event emitted when ignored returns false for dirs', async () => {
    const tmpDir = await makeTempDir();
    tempDirs.push(tmpDir);

    // Pre-create a file so chokidar has something to watch
    await fs.writeFile(path.join(tmpDir, 'existing.txt'), 'hi');

    const events: RecordedEvent[] = [];
    const watcher = chokidar.watch(tmpDir, {
      ignoreInitial: true,
      ignored: (_path: string, stats) => {
        if (!stats) return false;
        if (stats.isDirectory()) return false;
        // Ignore all files
        return true;
      },
    });
    activeWatchers.push(watcher);
    collectEvents(watcher, events);
    await waitForReady(watcher);

    // Clear initial events
    events.length = 0;
    await delay(200);
    events.length = 0;

    // Create a new subdirectory
    const subDir = path.join(tmpDir, 'newsubdir');
    await fs.mkdir(subDir);

    await delay(1500);

    const addDirEvents = events.filter((e) => e.event === 'addDir');
    console.log(
      `[Probe 1] Platform: ${process.platform}, addDir events:`,
      addDirEvents.map((e) => e.path),
    );
    console.log(
      `[Probe 1] All events:`,
      events.map((e) => `${e.event}:${e.path}`),
    );

    // This is the core question: does the addDir event fire?
    // We expect it does fire (which is the problem the emit filter solves).
    assert.ok(
      addDirEvents.length > 0,
      'Expected addDir event for new subdirectory when ignored returns false for dirs',
    );
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Probe 2: File changes inside a sibling directory.
  //
  // Setup: Watch with `ignored` returning false for dirs, and only matching
  // files in subdir "src/". After ready, create a file in "other/". Does
  // chokidar emit events for files inside "other/"?
  //
  // The ignored callback should filter those files out, but we want to
  // verify this works the same across platforms.
  // ──────────────────────────────────────────────────────────────────────────
  test('Probe 2: file in unrelated dir is filtered by ignored callback', async () => {
    const tmpDir = await makeTempDir();
    tempDirs.push(tmpDir);

    const srcDir = path.join(tmpDir, 'src');
    const otherDir = path.join(tmpDir, 'other');
    await fs.mkdir(srcDir);
    await fs.mkdir(otherDir);
    await fs.writeFile(path.join(srcDir, 'index.js'), 'console.log("hi")');

    const events: RecordedEvent[] = [];
    const watcher = chokidar.watch(tmpDir, {
      ignoreInitial: true,
      ignored: (filePath: string, stats) => {
        if (!stats) return false;
        if (stats.isDirectory()) return false;
        // Only allow files under src/
        const resolved = path.resolve(filePath);
        return !resolved.startsWith(srcDir + path.sep);
      },
    });
    activeWatchers.push(watcher);
    collectEvents(watcher, events);
    await waitForReady(watcher);
    events.length = 0;
    await delay(200);
    events.length = 0;

    // Create a file in the "other" directory (should be ignored)
    await fs.writeFile(path.join(otherDir, 'ignored.txt'), 'should not fire');

    await delay(1500);

    const fileEvents = events.filter(
      (e) =>
        (e.event === 'add' || e.event === 'change') &&
        e.path.includes('ignored.txt'),
    );
    const dirEvents = events.filter(
      (e) =>
        (e.event === 'addDir' || e.event === 'unlinkDir') &&
        e.path.includes('other'),
    );

    console.log(
      `[Probe 2] Platform: ${process.platform}, file events for ignored.txt:`,
      fileEvents.map((e) => `${e.event}:${e.path}`),
    );
    console.log(
      `[Probe 2] Dir events for "other":`,
      dirEvents.map((e) => `${e.event}:${e.path}`),
    );
    console.log(
      `[Probe 2] All events:`,
      events.map((e) => `${e.event}:${e.path}`),
    );

    // File should be filtered by `ignored`
    assert.strictEqual(
      fileEvents.length,
      0,
      'File in unrelated dir should be ignored',
    );

    // But directories might not be! This is exactly what the fix addresses.
    // We're just probing here, so log what happens.
    console.log(
      `[Probe 2] DIRECTORY EVENTS LEAKED: ${dirEvents.length > 0}`,
    );
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Probe 3: Does a directory change inside a watched tree trigger an
  // event on the parent watcher?
  //
  // This probes whether fs.watch on macOS (kqueue) delivers events for
  // deeply nested changes. On Linux (inotify), fs.watch is NOT recursive
  // by default — chokidar sets up per-directory watches. On Mac with
  // kqueue, behavior may differ from old fsevents.
  // ──────────────────────────────────────────────────────────────────────────
  test('Probe 3: deeply nested file creation visibility', async () => {
    const tmpDir = await makeTempDir();
    tempDirs.push(tmpDir);

    const deep = path.join(tmpDir, 'a', 'b', 'c');
    await fs.mkdir(deep, {recursive: true});

    const events: RecordedEvent[] = [];
    const watcher = chokidar.watch(tmpDir, {
      ignoreInitial: true,
      ignored: (_path: string, stats) => {
        if (!stats) return false;
        if (stats.isDirectory()) return false;
        return false; // Allow all files
      },
    });
    activeWatchers.push(watcher);
    collectEvents(watcher, events);
    await waitForReady(watcher);
    events.length = 0;
    await delay(200);
    events.length = 0;

    // Create a file deep in the tree
    await fs.writeFile(path.join(deep, 'deep-file.txt'), 'deep content');

    await delay(1500);

    console.log(
      `[Probe 3] Platform: ${process.platform}, events after deep file creation:`,
      events.map((e) => `${e.event}:${e.path}`),
    );

    const addEvents = events.filter(
      (e) => e.event === 'add' && e.path.includes('deep-file.txt'),
    );
    assert.ok(
      addEvents.length > 0,
      'Expected add event for deeply nested file',
    );
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Probe 4: "The wireit scenario"
  //
  // This directly simulates what wireit does: watch with glob-like patterns
  // where `ignored` returns false for all dirs, then create activity in a
  // sibling ".wireit" directory. This is the exact scenario the fix
  // targets. We want to know:
  //   (a) Do addDir/unlinkDir events fire for .wireit/ paths?
  //   (b) Do 'all' meta-events fire for those paths?
  //   (c) Is this different on Mac vs Linux vs Windows?
  // ──────────────────────────────────────────────────────────────────────────
  test('Probe 4: wireit scenario - sibling .wireit dir events', async () => {
    const tmpDir = await makeTempDir();
    tempDirs.push(tmpDir);

    const srcDir = path.join(tmpDir, 'src');
    const wireitDir = path.join(tmpDir, '.wireit');
    await fs.mkdir(srcDir);
    await fs.mkdir(wireitDir);
    await fs.writeFile(path.join(srcDir, 'index.js'), 'hello');

    const srcDirResolved = path.resolve(srcDir);

    const events: RecordedEvent[] = [];
    const watcher = chokidar.watch(tmpDir, {
      ignoreInitial: true,
      ignored: (filePath: string, stats) => {
        if (!stats) return false;
        if (stats.isDirectory()) return false;
        // Simulate: only watch *.js files in src/
        const resolved = path.resolve(filePath);
        if (
          resolved.startsWith(srcDirResolved + path.sep) &&
          resolved.endsWith('.js')
        ) {
          return false; // Don't ignore
        }
        return true; // Ignore everything else
      },
    });
    activeWatchers.push(watcher);
    collectEvents(watcher, events);
    await waitForReady(watcher);
    events.length = 0;
    await delay(200);
    events.length = 0;

    // Simulate wireit lock file activity
    const lockDir = path.join(wireitDir, 'locks');
    await fs.mkdir(lockDir);
    await fs.writeFile(path.join(lockDir, 'lockfile'), 'locked');
    await delay(300);
    await fs.writeFile(path.join(lockDir, 'lockfile'), 'updated');
    await delay(300);
    await fs.rm(path.join(lockDir, 'lockfile'));
    await delay(300);
    await fs.rmdir(lockDir);

    await delay(1500);

    const wireitEvents = events.filter(
      (e) => e.path.includes('.wireit') && !e.event.startsWith('all:'),
    );
    const wireitAllEvents = events.filter(
      (e) => e.path.includes('.wireit') && e.event.startsWith('all:'),
    );
    const srcEvents = events.filter(
      (e) => e.path.includes('src') && !e.event.startsWith('all:'),
    );

    console.log(
      `[Probe 4] Platform: ${process.platform}`,
    );
    console.log(
      `[Probe 4] .wireit direct events (${wireitEvents.length}):`,
      wireitEvents.map((e) => `${e.event}:${e.path}`),
    );
    console.log(
      `[Probe 4] .wireit 'all' events (${wireitAllEvents.length}):`,
      wireitAllEvents.map((e) => `${e.event}:${e.path}`),
    );
    console.log(
      `[Probe 4] src events:`,
      srcEvents.map((e) => `${e.event}:${e.path}`),
    );
    console.log(
      `[Probe 4] Total events:`,
      events.length,
    );
    console.log(
      `[Probe 4] SPURIOUS .wireit EVENTS: ${wireitEvents.length > 0}`,
    );
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Probe 5: Raw fs.watch behavior — does it deliver events for files
  // created in subdirectories?
  //
  // This bypasses chokidar entirely to probe the raw Node fs.watch API.
  // On Linux, fs.watch is NOT recursive. On Mac, it depends on the
  // options.recursive flag. On Windows, NTFS supports recursive natively.
  // ──────────────────────────────────────────────────────────────────────────
  test('Probe 5: raw fs.watch recursive behavior', async () => {
    const tmpDir = await makeTempDir();
    tempDirs.push(tmpDir);

    const subDir = path.join(tmpDir, 'sub');
    await fs.mkdir(subDir);

    const fsModule = await import('fs');

    // Test 1: Non-recursive watch
    const nonRecursiveEvents: string[] = [];
    let nonRecWatcher: ReturnType<typeof fsModule.watch> | undefined;
    try {
      nonRecWatcher = fsModule.watch(
        tmpDir,
        {recursive: false},
        (eventType, filename) => {
          nonRecursiveEvents.push(`${eventType}:${filename}`);
        },
      );
    } catch {
      console.log(
        `[Probe 5] Non-recursive fs.watch not supported on ${process.platform}`,
      );
    }

    // Test 2: Recursive watch (may not be supported on Linux)
    const recursiveEvents: string[] = [];
    let recWatcher: ReturnType<typeof fsModule.watch> | undefined;
    let recursiveSupported = true;
    try {
      recWatcher = fsModule.watch(
        tmpDir,
        {recursive: true},
        (eventType, filename) => {
          recursiveEvents.push(`${eventType}:${filename}`);
        },
      );
    } catch {
      recursiveSupported = false;
      console.log(
        `[Probe 5] Recursive fs.watch not supported on ${process.platform}`,
      );
    }

    await delay(200);

    // Create a file in the subdirectory
    await fs.writeFile(path.join(subDir, 'nested.txt'), 'nested');
    // Create a file directly in the watched directory
    await fs.writeFile(path.join(tmpDir, 'root.txt'), 'root');

    await delay(1500);

    console.log(`[Probe 5] Platform: ${process.platform}`);
    console.log(
      `[Probe 5] Non-recursive fs.watch events:`,
      nonRecursiveEvents,
    );
    console.log(
      `[Probe 5] Recursive fs.watch supported: ${recursiveSupported}`,
    );
    if (recursiveSupported) {
      console.log(
        `[Probe 5] Recursive fs.watch events:`,
        recursiveEvents,
      );
    }

    nonRecWatcher?.close();
    recWatcher?.close();

    // Just log, don't assert — we want to observe cross-platform differences
    console.log(
      `[Probe 5] Non-recursive saw nested: ${nonRecursiveEvents.some((e) => e.includes('nested'))}`,
    );
    if (recursiveSupported) {
      console.log(
        `[Probe 5] Recursive saw nested: ${recursiveEvents.some((e) => e.includes('nested'))}`,
      );
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Probe 6: Does chokidar use recursive mode on each platform?
  //
  // We observe what fs.watch calls chokidar makes internally by checking
  // the events that come through. On Mac, if chokidar uses non-recursive
  // watches (one per directory), the behavior would be different from
  // recursive. This probe adds a directory and checks if chokidar sees it
  // without explicit re-scanning.
  // ──────────────────────────────────────────────────────────────────────────
  test('Probe 6: chokidar event delivery for new dir + file combo', async () => {
    const tmpDir = await makeTempDir();
    tempDirs.push(tmpDir);

    await fs.writeFile(path.join(tmpDir, 'existing.txt'), 'hi');

    const events: RecordedEvent[] = [];
    const watcher = chokidar.watch(tmpDir, {
      ignoreInitial: true,
    });
    activeWatchers.push(watcher);
    collectEvents(watcher, events);
    await waitForReady(watcher);
    events.length = 0;
    await delay(200);
    events.length = 0;

    // Create a new directory and then a file inside it
    const newDir = path.join(tmpDir, 'newdir');
    await fs.mkdir(newDir);
    // Small delay to let chokidar process the directory creation
    await delay(500);
    await fs.writeFile(path.join(newDir, 'newfile.txt'), 'new content');

    await delay(2000);

    const addDirEvents = events.filter((e) => e.event === 'addDir');
    const addFileEvents = events.filter(
      (e) => e.event === 'add' && e.path.includes('newfile'),
    );

    console.log(`[Probe 6] Platform: ${process.platform}`);
    console.log(
      `[Probe 6] addDir events:`,
      addDirEvents.map((e) => e.path),
    );
    console.log(
      `[Probe 6] add events for newfile:`,
      addFileEvents.map((e) => e.path),
    );
    console.log(
      `[Probe 6] All events:`,
      events.map((e) => `${e.event}:${e.path}`),
    );

    // We expect both events on all platforms, but the mechanism differs
    assert.ok(addDirEvents.length > 0, 'Expected addDir event for new dir');
    assert.ok(
      addFileEvents.length > 0,
      'Expected add event for file in new dir',
    );
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Probe 7: The emit filter itself.
  //
  // Test the actual chokidarWatchWithGlobs function to verify the emit
  // filter works correctly.
  // ──────────────────────────────────────────────────────────────────────────
  test('Probe 7: chokidarWatchWithGlobs filters .wireit events', async () => {
    const {chokidarWatchWithGlobs} = await import(
      '../util/chokidar-with-globs.js'
    );

    const tmpDir = await makeTempDir();
    tempDirs.push(tmpDir);

    const srcDir = path.join(tmpDir, 'src');
    const wireitDir = path.join(tmpDir, '.wireit');
    await fs.mkdir(srcDir);
    await fs.mkdir(wireitDir);
    await fs.writeFile(path.join(srcDir, 'index.js'), 'hello');

    const events: RecordedEvent[] = [];
    const watcher = chokidarWatchWithGlobs(['src/**/*.js'], {
      cwd: tmpDir,
      ignoreInitial: true,
    });
    activeWatchers.push(watcher);
    collectEvents(watcher, events);
    await waitForReady(watcher);
    events.length = 0;
    await delay(200);
    events.length = 0;

    // Activity in .wireit (should be filtered)
    const lockDir = path.join(wireitDir, 'locks');
    await fs.mkdir(lockDir);
    await fs.writeFile(path.join(lockDir, 'lockfile'), 'locked');
    await delay(300);
    await fs.rm(path.join(lockDir, 'lockfile'));
    await delay(300);
    await fs.rmdir(lockDir);

    // Activity in src (should be visible)
    await delay(300);
    await fs.writeFile(path.join(srcDir, 'new.js'), 'new file');

    await delay(2000);

    const wireitEvents = events.filter((e) => e.path.includes('.wireit'));
    const srcEvents = events.filter(
      (e) => e.path.includes('src') || e.path.includes('new.js'),
    );

    console.log(`[Probe 7] Platform: ${process.platform}`);
    console.log(
      `[Probe 7] .wireit events (should be 0):`,
      wireitEvents.map((e) => `${e.event}:${e.path}`),
    );
    console.log(
      `[Probe 7] src events (should be > 0):`,
      srcEvents.map((e) => `${e.event}:${e.path}`),
    );

    assert.strictEqual(
      wireitEvents.length,
      0,
      '.wireit events should be filtered out by chokidarWatchWithGlobs',
    );
    assert.ok(
      srcEvents.length > 0,
      'src events should pass through',
    );
  });
});
