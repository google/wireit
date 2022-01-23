import {test} from 'uvu';
import * as assert from 'uvu/assert';
import {TestRig} from './util/test-rig.js';

test('watch 1 task', async () => {
  const rig = new TestRig();
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
  await rig.writeFiles({'input.txt': 'v1'});
  await cmd.waitUntilStarted();
  await cmd.exit(0);
  await rig.sleep(50);
  assert.equal(cmd.startedCount, 2);

  // Kill the parent process.
  process.kill('SIGINT');
  const {code} = await process.done;
  assert.equal(code, 0);

  await rig.cleanup();
});

test('watch 2 task', async () => {
  const rig = new TestRig();
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
  assert.equal(code, 0);

  await rig.cleanup();
});

test.run();
