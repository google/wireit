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

test('1 task succeeds', async ({rig}) => {
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
          },
        },
      },
    },
  });
  const out = rig.exec('npm run cmd');
  await cmd.waitUntilStarted();
  await cmd.exit(0);
  const {code} = await out.done;
  assert.equal(code, 0);
});

test('runs node binaries when invoked via npm script', async ({rig}) => {
  const cmd = rig.newCommand();
  await rig.writeFiles({
    'package.json': {
      scripts: {
        cmd: 'wireit',
      },
      wireit: {
        tasks: {
          cmd: {
            command: 'installed-binary',
          },
        },
      },
    },
    'node_modules/.bin/installed-binary': [
      '#!/usr/bin/env bash',
      cmd.command(),
    ].join('\n'),
  });
  await rig.chmod('node_modules/.bin/installed-binary', '755');
  const out = rig.exec('npm run cmd');
  await cmd.waitUntilStarted();
  await cmd.exit(0);
  const {code} = await out.done;
  assert.equal(code, 0);
});

test('runs node binaries when invoked directly', async ({rig}) => {
  const cmd = rig.newCommand();
  await rig.writeFiles({
    'package.json': {
      wireit: {
        tasks: {
          cmd: {
            command: 'installed-binary',
          },
        },
      },
    },
    'node_modules/.bin/installed-binary': [
      '#!/usr/bin/env bash',
      cmd.command(),
    ].join('\n'),
  });
  await rig.chmod('node_modules/.bin/installed-binary', '755');
  const out = rig.exec('node ../../../bin/wireit.js run cmd');
  await cmd.waitUntilStarted();
  await cmd.exit(0);
  const {code} = await out.done;
  assert.equal(code, 0);
});

test('1 task fails', async ({rig}) => {
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
          },
        },
      },
    },
  });
  const out = rig.exec('npm run cmd');
  await cmd.waitUntilStarted();
  await cmd.exit(37); // Specific code doesn't matter.
  const {code} = await out.done;
  assert.equal(code, 1);
  assert.equal(cmd.startedCount, 1);
});

test('2 tasks, 2 succeed', async ({rig}) => {
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
            dependencies: ['cmd2'],
          },
          cmd2: {
            command: cmd2.command(),
          },
        },
      },
    },
  });

  const out = rig.exec('npm run cmd1');

  await cmd2.waitUntilStarted();

  // cmd1 shouldn't start until cmd2 has finished
  await rig.sleep(50);
  assert.not(cmd1.running);
  await cmd2.exit(0);
  await cmd1.waitUntilStarted();

  await cmd1.exit(0);
  const {code} = await out.done;
  assert.equal(code, 0);
  assert.equal(cmd1.startedCount, 1);
  assert.equal(cmd2.startedCount, 1);
});

test('2 tasks, first fails', async ({rig}) => {
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
            dependencies: ['cmd2'],
          },
          cmd2: {
            command: cmd2.command(),
          },
        },
      },
    },
  });

  const out = rig.exec('npm run cmd1');

  await cmd2.waitUntilStarted();
  await cmd2.exit(37);

  // Fail because a task failed
  const {code} = await out.done;
  assert.equal(code, 1);

  // cmd1 should never have started
  await rig.sleep(50);
  assert.not(cmd1.running);
  assert.equal(cmd1.startedCount, 0);
  assert.equal(cmd2.startedCount, 1);
});

/**
 *     cmd1 <-- run
 *     /   \
 *    /     \
 *   v       v
 *  cmd2   cmd3
 *    \     /
 *     \   /
 *      v v
 *      cmd4
 */
test('diamond', async ({rig}) => {
  const cmd1 = rig.newCommand();
  const cmd2 = rig.newCommand();
  const cmd3 = rig.newCommand();
  const cmd4 = rig.newCommand();

  await rig.writeFiles({
    'package.json': {
      scripts: {
        cmd1: 'wireit',
      },
      wireit: {
        tasks: {
          cmd1: {
            command: cmd1.command(),
            dependencies: ['cmd2', 'cmd3'],
          },
          cmd2: {
            command: cmd2.command(),
            dependencies: ['cmd4'],
          },
          cmd3: {
            command: cmd3.command(),
            dependencies: ['cmd4'],
          },
          cmd4: {
            command: cmd4.command(),
          },
        },
      },
    },
  });

  const out = rig.exec('npm run cmd1');

  await cmd4.waitUntilStarted();
  await cmd4.exit(0);

  await cmd2.waitUntilStarted();
  await cmd3.waitUntilStarted();
  await cmd2.exit(0);
  await cmd3.exit(0);

  await cmd1.waitUntilStarted();
  await cmd1.exit(0);

  const {code} = await out.done;
  assert.equal(code, 0);
  assert.equal(cmd1.startedCount, 1);
  assert.equal(cmd2.startedCount, 1);
  assert.equal(cmd3.startedCount, 1);
  assert.equal(cmd4.startedCount, 1);
});

test('cross package', async ({rig}) => {
  const cmd1 = rig.newCommand();
  const cmd2 = rig.newCommand();
  await rig.writeFiles({
    'pkg1/package.json': {
      scripts: {
        cmd1: 'wireit',
      },
      wireit: {
        tasks: {
          cmd1: {
            command: cmd1.command(),
            dependencies: ['../pkg2:cmd2'],
          },
        },
      },
    },
    'pkg2/package.json': {
      wireit: {
        tasks: {
          cmd2: {
            command: cmd2.command(),
          },
        },
      },
    },
  });

  const out = rig.exec('npm run cmd1', {cwd: 'pkg1'});

  await cmd2.waitUntilStarted();
  await rig.sleep(50);
  assert.not(cmd1.running);
  await cmd2.exit(0);
  await cmd1.waitUntilStarted();

  await cmd1.exit(0);
  const {code} = await out.done;
  assert.equal(code, 0);
  assert.equal(cmd1.startedCount, 1);
  assert.equal(cmd2.startedCount, 1);
});

test('1 task: run, cached, run, cached', async ({rig}) => {
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
      'input.txt': 'v1',
    },
  });

  // [1] Run the first time.
  {
    const out = rig.exec('npm run cmd');
    await cmd.waitUntilStarted();
    await cmd.exit(0);
    const {code} = await out.done;
    assert.equal(code, 0);
    assert.equal(cmd.startedCount, 1);
  }

  // [2] Don't run because the input files haven't changed.
  {
    const out = rig.exec('npm run cmd');
    const {code} = await out.done;
    assert.equal(code, 0);
    await rig.sleep(50);
    assert.equal(cmd.startedCount, 1);
  }

  // [3] Change the input files. Now we should run again.
  {
    await rig.writeFiles({'input.txt': 'v2'});
    const out = rig.exec('npm run cmd');
    await cmd.waitUntilStarted();
    await cmd.exit(0);
    const {code} = await out.done;
    assert.equal(code, 0);
    assert.equal(cmd.startedCount, 2);
  }

  // [4] Don't run because the input files haven't changed.
  {
    const out = rig.exec('npm run cmd');
    const {code} = await out.done;
    assert.equal(code, 0);
    await rig.sleep(50);
    assert.equal(cmd.startedCount, 2);
  }
});

test('2 tasks: run, cached, run, cached', async ({rig}) => {
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
            dependencies: ['cmd2'],
          },
          cmd2: {
            command: cmd2.command(),
            files: ['cmd2.input.txt'],
          },
        },
      },
    },
    'cmd2.input.txt': 'v1',
  });

  // [1] Run both the first time.
  {
    const out = rig.exec('npm run cmd1');
    await cmd2.waitUntilStarted();
    // cmd1 shouldn't start until cmd2 has finished
    await rig.sleep(50);
    assert.not(cmd1.running);
    await cmd2.exit(0);
    await cmd1.waitUntilStarted();
    await cmd1.exit(0);
    const {code} = await out.done;
    assert.equal(code, 0);
    assert.equal(cmd1.startedCount, 1);
    assert.equal(cmd2.startedCount, 1);
  }

  // [2] Don't run because the input files haven't changed.
  {
    const out = rig.exec('npm run cmd1');
    const {code} = await out.done;
    assert.equal(code, 0);
    await rig.sleep(50);
    assert.equal(cmd1.startedCount, 1);
    assert.equal(cmd2.startedCount, 1);
  }

  // [3] Change the input file. Now both should run again.
  {
    await rig.writeFiles({
      'cmd2.input.txt': 'v1',
    });
    const out = rig.exec('npm run cmd1');
    await cmd2.waitUntilStarted();
    // cmd1 shouldn't start until cmd2 has finished
    await rig.sleep(50);
    assert.not(cmd1.running);
    await cmd2.exit(0);
    await cmd1.waitUntilStarted();
    await cmd1.exit(0);
    const {code} = await out.done;
    assert.equal(code, 0);
    assert.equal(cmd1.startedCount, 2);
    assert.equal(cmd2.startedCount, 2);
  }

  // [4] Don't run because the input files haven't changed.
  {
    const out = rig.exec('npm run cmd1');
    const {code} = await out.done;
    assert.equal(code, 0);
    await rig.sleep(50);
    assert.equal(cmd1.startedCount, 2);
    assert.equal(cmd2.startedCount, 2);
  }
});

test('2 tasks: run, cached, run, cached', async ({rig}) => {
  const cmd1 = rig.newCommand();
  const cmd2 = rig.newCommand();
  await rig.writeFiles({
    'package.json': {
      scripts: {
        cmd1: 'wireit',
        cmd2: 'wireit',
      },
      wireit: {
        tasks: {
          cmd1: {
            command: cmd1.command(),
            dependencies: ['cmd2'],
          },
          cmd2: {
            command: cmd2.command(),
            files: ['cmd2.input.txt'],
          },
        },
      },
    },
    'cmd2.input.txt': 'v1',
  });

  // [1] Run both the first time.
  {
    const out = rig.exec('npm run cmd1');
    await cmd2.waitUntilStarted();
    // cmd1 shouldn't start until cmd2 has finished
    await rig.sleep(50);
    assert.not(cmd1.running);
    await cmd2.exit(0);
    await cmd1.waitUntilStarted();
    await cmd1.exit(0);
    const {code} = await out.done;
    assert.equal(code, 0);
    assert.equal(cmd1.startedCount, 1);
    assert.equal(cmd2.startedCount, 1);
  }

  // [2] Don't run because the input files haven't changed.
  {
    const out = rig.exec('npm run cmd1');
    const {code} = await out.done;
    assert.equal(code, 0);
    await rig.sleep(50);
    assert.equal(cmd1.startedCount, 1);
    assert.equal(cmd2.startedCount, 1);
  }

  // [3] Change the input file and run cmd2.
  {
    await rig.writeFiles({
      'cmd2.input.txt': 'v1',
    });
    const out = rig.exec('npm run cmd2');
    await cmd2.waitUntilStarted();
    await cmd2.exit(0);
    const {code} = await out.done;
    assert.equal(code, 0);
    assert.equal(cmd1.startedCount, 1);
    assert.equal(cmd2.startedCount, 2);
  }

  // [4] Now run cmd1. It should run because cmd2 recently ran with different
  // inputs.
  {
    const out = rig.exec('npm run cmd1');
    await cmd1.waitUntilStarted();
    await cmd1.exit(0);
    const {code} = await out.done;
    assert.equal(code, 0);
    assert.equal(cmd1.startedCount, 2);
    assert.equal(cmd2.startedCount, 2);
  }

  // [5] Don't run because the input files haven't changed.
  {
    const out = rig.exec('npm run cmd1');
    const {code} = await out.done;
    assert.equal(code, 0);
    await rig.sleep(50);
    assert.equal(cmd1.startedCount, 2);
    assert.equal(cmd2.startedCount, 2);
  }
});

test('detects cycles of length 1', async ({rig}) => {
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
            dependencies: ['cmd'],
          },
        },
      },
    },
  });
  const out = rig.exec('npm run cmd');
  const {code} = await out.done;
  await rig.sleep(50);
  assert.equal(cmd.startedCount, 0);
  assert.equal(code, 1);
});

test('detects cycles of length 2', async ({rig}) => {
  const cmd1 = rig.newCommand();
  const cmd2 = rig.newCommand();
  await rig.writeFiles({
    'package.json': {
      scripts: {
        cmd: 'wireit',
      },
      wireit: {
        tasks: {
          cmd1: {
            command: cmd1.command(),
            dependencies: ['cmd2'],
          },
          cmd2: {
            command: cmd2.command(),
            dependencies: ['cmd1'],
          },
        },
      },
    },
  });
  const out = rig.exec('npm run cmd');
  const {code} = await out.done;
  await rig.sleep(50);
  assert.equal(cmd1.startedCount, 0);
  assert.equal(cmd2.startedCount, 0);
  assert.equal(code, 1);
});

test('package-lock changes invalidate cache keys', async ({rig}) => {
  const cmd1 = rig.newCommand();
  const cmd2 = rig.newCommand();
  await rig.writeFiles({
    'foo/package.json': {
      scripts: {
        cmd1: 'wireit',
        cmd2: 'wireit',
      },
      wireit: {
        tasks: {
          cmd1: {
            command: cmd1.command(),
          },
          cmd2: {
            command: cmd2.command(),
            npm: false,
          },
        },
      },
    },
    'package-lock.json': 'v1',
    'foo/package-lock.json': 'v1',
  });

  // Command 1 and 2 always run the first time.

  {
    const out = rig.exec('npm run cmd1', {cwd: 'foo'});
    await cmd1.waitUntilStarted();
    await cmd1.exit(0);
    const {code} = await out.done;
    assert.equal(code, 0);
    assert.equal(cmd1.startedCount, 1);
  }

  {
    const out = rig.exec('npm run cmd2', {cwd: 'foo'});
    await cmd2.waitUntilStarted();
    await cmd2.exit(0);
    const {code} = await out.done;
    assert.equal(code, 0);
    assert.equal(cmd2.startedCount, 1);
  }

  // Neither command 1 nor 2 run again because nothing has changed.

  {
    const out = rig.exec('npm run cmd1', {cwd: 'foo'});
    const {code} = await out.done;
    assert.equal(code, 0);
    assert.equal(cmd1.startedCount, 1);
  }

  {
    const out = rig.exec('npm run cmd2', {cwd: 'foo'});
    const {code} = await out.done;
    assert.equal(code, 0);
    assert.equal(cmd2.startedCount, 1);
  }

  // Change foo/package-lock.json. Command 1 should run because we respect
  // package-locks by default. Command 2 should not run because it has npm:false
  // configured.

  await rig.writeFiles({'foo/package-lock.json': 'v2'});

  {
    const out = rig.exec('npm run cmd1', {cwd: 'foo'});
    await cmd1.waitUntilStarted();
    await cmd1.exit(0);
    const {code} = await out.done;
    assert.equal(code, 0);
    assert.equal(cmd1.startedCount, 2);
  }

  {
    const out = rig.exec('npm run cmd2', {cwd: 'foo'});
    const {code} = await out.done;
    assert.equal(code, 0);
    assert.equal(cmd2.startedCount, 1);
  }

  // Change the parent package-lock.json. This should also invalidate command 1,
  // because we recursively check the package locks of all parent directories.

  await rig.writeFiles({'package-lock.json': 'v2'});

  {
    const out = rig.exec('npm run cmd1', {cwd: 'foo'});
    await cmd1.waitUntilStarted();
    await cmd1.exit(0);
    const {code} = await out.done;
    assert.equal(code, 0);
    assert.equal(cmd1.startedCount, 3);
  }

  {
    const out = rig.exec('npm run cmd2', {cwd: 'foo'});
    const {code} = await out.done;
    assert.equal(code, 0);
    assert.equal(cmd2.startedCount, 1);
  }
});

test('SIGINT waits for children to exit', async ({rig}) => {
  const cmd1 = rig.newCommand();
  const cmd2 = rig.newCommand();
  const cmd3 = rig.newCommand();
  await rig.writeFiles({
    'package.json': {
      scripts: {
        cmd1: 'wireit',
      },
      wireit: {
        tasks: {
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
    },
  });
  const process = rig.exec('npm run cmd1');

  // The two dependency processes should start in parallel.
  await cmd2.waitUntilStarted();
  await cmd3.waitUntilStarted();

  // Now we send SIGINT to the main wireit process.
  process.kill('SIGINT');

  // Both dependency processes should receive this.
  assert.equal(await cmd2.receivedSignal, 'SIGINT');
  assert.equal(await cmd3.receivedSignal, 'SIGINT');

  // Child 1/1, but we can't exit yet because 2/2 is still running.
  await cmd2.exit(1);
  await rig.sleep(50);
  assert.equal(process.running(), true);

  // Child 2/2 exits
  await cmd3.exit(1);

  // Now the main process can exit.
  const {code} = await process.done;
  assert.equal(code, 1);

  // cmd1 should never have started, the other two started once each.
  assert.equal(cmd1.startedCount, 0);
  assert.equal(cmd2.startedCount, 1);
  assert.equal(cmd3.startedCount, 1);
});

test.run();
