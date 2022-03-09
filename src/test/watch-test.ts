/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {TestRig} from './util/test-rig.js';
import {timeout} from './util/uvu-timeout.js';

const test = suite<{rig: TestRig}>();

test.before.each(async (ctx) => {
  ctx.rig = new TestRig();
  await ctx.rig.setup();
});

test.after.each(async (ctx) => {
  await ctx.rig.cleanup();
});

test(
  'watch 1 script',
  timeout(async ({rig}) => {
    const cmd = rig.newCommand();
    await rig.writeFiles({
      'package.json': {
        scripts: {
          cmd: 'wireit',
        },
        wireit: {
          cmd: {
            command: cmd.command(),
            files: ['input.txt'],
          },
        },
      },
      'input.txt': 'v1',
    });

    // Start watching
    const process = rig.exec('npm run cmd -- watch');

    // There's always an initial run
    await cmd.waitUntilStarted();
    await cmd.exit(0);

    // Make sure nothing happens for a while
    await rig.sleep(50);
    assert.equal(cmd.startedCount, 1);

    // Modify the input. Expect another run.
    await rig.writeFiles({'input.txt': 'v2'});
    await cmd.waitUntilStarted();
    await cmd.exit(0);
    await rig.sleep(50);
    assert.equal(cmd.startedCount, 2);

    // Kill the parent process.
    process.kill('SIGINT');
    const {code} = await process.done;
    assert.equal(code, 130);
  })
);

test(
  'watch 2 script',
  timeout(async ({rig}) => {
    const cmd1 = rig.newCommand();
    const cmd2 = rig.newCommand();
    await rig.writeFiles({
      'package.json': {
        scripts: {
          cmd1: 'wireit',
          cmd2: 'wireit',
        },
        wireit: {
          cmd1: {
            command: cmd1.command(),
            files: ['cmd1.input.txt'],
            dependencies: ['cmd2'],
          },
          cmd2: {
            command: cmd2.command(),
            files: ['cmd2.input.txt'],
          },
        },
      },
      'cmd1.input.txt': 'v1',
      'cmd2.input.txt': 'v1',
    });

    // Start watching
    const process = rig.exec('npx wireit watch cmd1');

    // There's always an initial run
    await cmd2.waitUntilStarted();
    await cmd2.exit(0);
    await cmd1.waitUntilStarted();
    await cmd1.exit(0);
    await rig.sleep(50);
    assert.equal(cmd1.startedCount, 1);
    assert.equal(cmd2.startedCount, 1);

    // Modify inputs to cmd1. Expect only cmd1 runs.
    await rig.writeFiles({'cmd1.input.txt': 'v2'});
    await cmd1.waitUntilStarted();
    await cmd1.exit(0);
    await rig.sleep(50);
    assert.equal(cmd1.startedCount, 2);
    assert.equal(cmd2.startedCount, 1);

    // Modify inputs to cmd1. Expect only cmd1 runs.
    await rig.writeFiles({'cmd2.input.txt': 'v2'});
    await cmd2.waitUntilStarted();
    await cmd2.exit(0);
    await cmd1.waitUntilStarted();
    await cmd1.exit(0);
    await rig.sleep(50);
    assert.equal(cmd1.startedCount, 3);
    assert.equal(cmd2.startedCount, 2);

    // Kill the parent process.
    process.kill('SIGINT');
    const {code} = await process.done;
    assert.equal(code, 130);
  })
);

test(
  'file modified during run in non-interrupt mode',
  timeout(async ({rig}) => {
    const cmd = rig.newCommand();
    await rig.writeFiles({
      'package.json': {
        scripts: {
          cmd: 'wireit',
        },
        wireit: {
          cmd: {
            command: cmd.command(),
            files: ['input.txt'],
          },
        },
      },
      'input.txt': 'v1',
    });

    // Start watching
    const process = rig.exec('npx wireit watch cmd');

    // There's always an initial run
    await cmd.waitUntilStarted();
    await cmd.exit(0);
    await rig.sleep(50);
    assert.equal(cmd.startedCount, 1);

    // Modify the input. A second run starts.
    await rig.writeFiles({'input.txt': 'v2'});
    await cmd.waitUntilStarted();

    // Before the first run finishes, we modify the input again.
    await rig.writeFiles({'input.txt': 'v3'});

    // Ensure we don't start the second run before the first finishes.
    await rig.sleep(1000);
    assert.equal(cmd.startedCount, 2);

    // Eventually the first run finishes.
    await cmd.exit(0);

    // And we should trigger another run right away.
    await cmd.waitUntilStarted();
    await cmd.exit(0);

    // Expect 3 runs in total.
    await rig.sleep(100);
    assert.equal(cmd.startedCount, 3);

    // Kill the parent process.
    process.kill('SIGINT');
    const {code} = await process.done;
    assert.equal(code, 130);
  })
);

test(
  'file modified during run in interrupt mode',
  timeout(async ({rig}) => {
    const cmd = rig.newCommand();
    await rig.writeFiles({
      'package.json': {
        scripts: {
          cmd: 'wireit',
        },
        wireit: {
          cmd: {
            command: cmd.command(),
            files: ['input.txt'],
          },
        },
      },
      'input.txt': 'v1',
    });

    // Start watching
    const process = rig.exec('npm run cmd -- watch --interrupt');

    // There's always an initial run
    await cmd.waitUntilStarted();
    await cmd.exit(0);

    // Modify the input. Expect another run to start.
    await rig.writeFiles({'input.txt': 'v2'});
    await cmd.waitUntilStarted();

    // Modify the input while running.
    const cmdSignal = cmd.receivedSignal;
    await rig.writeFiles({'input.txt': 'v3'});

    // The current run should be aborted.
    assert.equal(await cmdSignal, 'SIGINT');
    await cmd.exit(1);

    // And then another run should start. Let this one finish.
    await cmd.waitUntilStarted();
    await cmd.exit(1);

    // Kill the parent process.
    process.kill('SIGINT');
    const {code} = await process.done;
    assert.equal(code, 130);
    assert.equal(cmd.startedCount, 3);
  })
);

test(
  "don't kill watcher when script fails",
  timeout(async ({rig}) => {
    const cmd = rig.newCommand();
    await rig.writeFiles({
      'package.json': {
        scripts: {
          cmd: 'wireit',
        },
        wireit: {
          cmd: {
            command: cmd.command(),
            files: ['input.txt'],
          },
        },
      },
      'input.txt': 'v1',
    });

    // Start watching
    const process = rig.exec('npx wireit watch cmd');

    // Initial run fails
    await cmd.waitUntilStarted();
    await cmd.exit(1);
    assert.equal(process.running(), true);

    // Make sure nothing happens for a while
    await rig.sleep(50);
    assert.equal(cmd.startedCount, 1);
    assert.equal(process.running(), true);

    // Modify the input. Expect another run. This time it succeeds.
    await rig.writeFiles({'input.txt': 'v2'});
    await cmd.waitUntilStarted();
    await cmd.exit(0);
    await rig.sleep(50);
    assert.equal(cmd.startedCount, 2);
    assert.equal(process.running(), true);

    // Modify the input. Expect another run. Fails.
    await rig.writeFiles({'input.txt': 'v3'});
    await cmd.waitUntilStarted();
    await cmd.exit(1);
    await rig.sleep(50);
    assert.equal(cmd.startedCount, 3);
    assert.equal(process.running(), true);

    // Modify the input. Expect another run. Succeeds.
    await rig.writeFiles({'input.txt': 'v4'});
    await cmd.waitUntilStarted();
    await cmd.exit(0);
    await rig.sleep(50);
    assert.equal(cmd.startedCount, 4);
    assert.equal(process.running(), true);

    // Kill the parent process.
    process.kill('SIGINT');
    const {code} = await process.done;
    assert.equal(code, 130);
    assert.equal(process.running(), false);
  })
);

test(
  'watch package-lock.json files',
  timeout(async ({rig}) => {
    const cmd1 = rig.newCommand();
    const cmd2 = rig.newCommand();
    await rig.writeFiles({
      'foo/package.json': {
        scripts: {
          cmd1: 'wireit',
          cmd2: 'wireit',
        },
        wireit: {
          cmd1: {
            command: cmd1.command(),
            files: [],
            dependencies: ['cmd2'],
          },
          cmd2: {
            command: cmd2.command(),
            files: [],
            checkPackageLocks: false,
          },
        },
      },
      'foo/package-lock.json': 'v1',
      'package-lock.json': 'v1',
    });

    // Start watching
    const process = rig.exec('npx wireit watch cmd1', {cwd: 'foo'});

    // Both run initially.
    await cmd2.waitUntilStarted();
    await cmd2.exit(0);
    await cmd1.waitUntilStarted();
    await cmd1.exit(0);
    assert.equal(cmd1.startedCount, 1);
    assert.equal(cmd2.startedCount, 1);
    assert.equal(process.running(), true);

    // Modify the nearest package lock. Expect another run, but only of cmd1,
    // because cmd2 has checkPackageLocks:false.
    await rig.writeFiles({'foo/package-lock.json': 'v2'});
    await cmd1.waitUntilStarted();
    await cmd1.exit(0);
    assert.equal(cmd1.startedCount, 2);
    assert.equal(cmd2.startedCount, 1);
    assert.equal(process.running(), true);

    // Modify the parent package lock. Expect another run of only cmd1.
    await rig.writeFiles({'package-lock.json': 'v2'});
    await cmd1.waitUntilStarted();
    await cmd1.exit(0);
    assert.equal(cmd1.startedCount, 3);
    assert.equal(cmd2.startedCount, 1);
    assert.equal(process.running(), true);

    // TODO(aomarks) Why do we have to sleep here to avoid an ECONNRESET uncaught
    // error?
    await rig.sleep(0);

    // Kill the parent process.
    process.kill('SIGINT');
    const {code} = await process.done;
    assert.equal(code, 130);
    assert.equal(process.running(), false);
  })
);

test(
  'watch with --parallel=1',
  timeout(async ({rig}) => {
    const cmd1 = rig.newCommand();
    const cmd2 = rig.newCommand();
    const cmd3 = rig.newCommand();
    await rig.writeFiles({
      'package.json': {
        scripts: {
          cmd1: 'wireit',
          cmd2: 'wireit',
          cmd3: 'wireit',
        },
        wireit: {
          cmd1: {
            command: cmd1.command(),
            dependencies: ['cmd2', 'cmd3'],
          },
          cmd2: {
            command: cmd2.command(),
          },
          cmd3: {
            command: cmd3.command(),
          },
        },
      },
    });

    const pool = rig.pool();
    const process = rig.exec('npm run cmd1 -- watch --parallel=1');

    const a = await pool.next();
    assert.ok(a === cmd2 || a === cmd3);
    await rig.sleep(50);
    assert.equal(pool.counts, {running: 1, pending: 2, done: 0});

    await a.exit(0);
    const b = await pool.next();
    assert.ok(b === cmd2 || b === cmd3);
    assert.equal(pool.counts, {running: 1, pending: 1, done: 1});

    await b.exit(0);
    const c = await pool.next();
    assert.ok(c === cmd1);
    assert.equal(pool.counts, {running: 1, pending: 0, done: 2});

    await c.exit(0);
    process.kill('SIGINT');
    const {code} = await process.done;
    assert.equal(code, 130);
    assert.equal(pool.counts, {running: 0, pending: 0, done: 3});
  })
);

test(
  'watch with --parallel=2',
  timeout(async ({rig}) => {
    const cmd1 = rig.newCommand();
    const cmd2 = rig.newCommand();
    const cmd3 = rig.newCommand();
    const cmd4 = rig.newCommand();
    await rig.writeFiles({
      'package.json': {
        scripts: {
          cmd1: 'wireit',
          cmd2: 'wireit',
          cmd3: 'wireit',
          cmd4: 'wireit',
        },
        wireit: {
          cmd1: {
            command: cmd1.command(),
            dependencies: ['cmd2', 'cmd3', 'cmd4'],
          },
          cmd2: {
            command: cmd2.command(),
          },
          cmd3: {
            command: cmd3.command(),
          },
          cmd4: {
            command: cmd4.command(),
          },
        },
      },
    });

    const pool = rig.pool();
    const process = rig.exec('npm run cmd1 -- watch --parallel=2');

    const a = await pool.next();
    assert.ok(a === cmd2 || a === cmd3 || a === cmd4);
    const b = await pool.next();
    assert.ok(b === cmd2 || b === cmd3 || b === cmd4);
    await rig.sleep(50);
    assert.equal(pool.counts, {running: 2, pending: 2, done: 0});

    await a.exit(0);
    const c = await pool.next();
    assert.ok(c === cmd2 || c === cmd3 || c === cmd4);
    assert.equal(pool.counts, {running: 2, pending: 1, done: 1});

    await b.exit(0);
    assert.equal(pool.counts, {running: 1, pending: 1, done: 2});

    await c.exit(0);
    const d = await pool.next();
    assert.ok(d === cmd1);
    assert.equal(pool.counts, {running: 1, pending: 0, done: 3});

    await d.exit(0);
    process.kill('SIGINT');
    const {code} = await process.done;
    assert.equal(code, 130);
    assert.equal(pool.counts, {running: 0, pending: 0, done: 4});
  })
);

// TODO(aomarks) Not implemented yet
test.skip(
  'wireit config should trigger watch change',
  timeout(async ({rig}) => {
    const cmd1 = rig.newCommand();
    const cmd2 = rig.newCommand();

    // Initially we have only one command.
    await rig.writeFiles({
      'package.json': {
        scripts: {
          cmd1: 'wireit',
        },
        wireit: {
          cmd1: {
            command: cmd1.command(),
          },
        },
      },
    });

    // 1st run completes successfully.
    const process = rig.exec('npm run cmd1 -- watch');
    await cmd1.waitUntilStarted();
    await cmd1.exit(0);
    assert.equal(cmd1.startedCount, 1);
    assert.equal(cmd2.startedCount, 0);

    // Now we update the wireit config to add another command.
    await rig.writeFiles({
      'package.json': {
        scripts: {
          cmd1: 'wireit',
          cmd2: 'wireit',
        },
        wireit: {
          cmd1: {
            command: cmd1.command(),
            dependencies: ['cmd2'],
          },
          cmd2: {
            command: cmd2.command(),
          },
        },
      },
    });

    // // TODO(oamarks) SHOULD NOT NEED THIS
    // process.kill('SIGINT');
    // await process.done;
    // process = rig.exec('npm run cmd1 -- watch');
    // // ---------------

    // 2nd run completes successfully.
    await cmd2.waitUntilStarted();
    await cmd2.exit(0);
    await cmd1.waitUntilStarted();
    await cmd1.exit(0);
    assert.equal(cmd1.startedCount, 2);
    assert.equal(cmd2.startedCount, 1);

    // Kill the parent process.
    process.kill('SIGINT');
    const {code} = await process.done;
    assert.equal(code, 130);
  })
);

test.run();
