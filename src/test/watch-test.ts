import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {TestRig} from './util/test-rig.js';

const test = suite<{rig: TestRig}>();

test.before.each((ctx) => {
  ctx.rig = new TestRig();
});

test.after.each(async (ctx) => {
  await ctx.rig.cleanup();
});

test('watch 1 task', async ({rig}) => {
  const cmd = rig.newCommand();
  await rig.writeFiles({
    'package.json': {
      scripts: {
        cmd: 'wireit',
      },
      wireit: {
        tasks: {
          cmd: {
            command: cmd.command(),
            files: ['input.txt'],
          },
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
});

test('watch 2 task', async ({rig}) => {
  const cmd1 = rig.newCommand();
  const cmd2 = rig.newCommand();
  await rig.writeFiles({
    'package.json': {
      scripts: {
        cmd1: 'wireit',
      },
      wireit: {
        tasks: {
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
});

test('watch modified during run', async ({rig}) => {
  const cmd = rig.newCommand();
  await rig.writeFiles({
    'package.json': {
      scripts: {
        cmd: 'wireit',
      },
      wireit: {
        tasks: {
          cmd: {
            command: cmd.command(),
            files: ['input.txt'],
          },
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
  await rig.sleep(100);
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
});

test("don't kill watcher when task fails", async ({rig}) => {
  const cmd = rig.newCommand();
  await rig.writeFiles({
    'package.json': {
      scripts: {
        cmd: 'wireit',
      },
      wireit: {
        tasks: {
          cmd: {
            command: cmd.command(),
            files: ['input.txt'],
          },
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
  await rig.writeFiles({'input.txt': 'v2'});
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
});

test('watch package-lock.json files', async ({rig}) => {
  const cmd1 = rig.newCommand();
  const cmd2 = rig.newCommand();
  await rig.writeFiles({
    'foo/package.json': {
      scripts: {
        cmd1: 'wireit',
      },
      wireit: {
        tasks: {
          cmd1: {
            command: cmd1.command(),
            dependencies: ['cmd2'],
          },
          cmd2: {
            command: cmd2.command(),
            npm: false,
          },
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
  // because cmd2 has npm:false.
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
});

test.run();
