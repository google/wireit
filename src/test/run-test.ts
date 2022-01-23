import {test} from 'uvu';
import * as assert from 'uvu/assert';
import {TestRig} from './util/test-rig.js';

test('1 task succeeds', async () => {
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

  // TODO(aomarks) Cleanup should happen even on failure. Is there a way to do
  // that in uvu?
  await rig.cleanup();
});

test('runs node binaries when invoked via npm script', async () => {
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

  await rig.cleanup();
});

test('runs node binaries when invoked directly', async () => {
  const rig = new TestRig();
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

  await rig.cleanup();
});

test('1 task fails', async () => {
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
  await rig.cleanup();
});

test('2 tasks, 2 succeed', async () => {
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
  await rig.cleanup();
});

test('2 tasks, first fails', async () => {
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

  await rig.cleanup();
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
test('diamond', async () => {
  const rig = new TestRig();
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

  await rig.cleanup();
});

test('cross package', async () => {
  const rig = new TestRig();
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
  await rig.cleanup();
});

test('1 task: run, cached, run, cached', async () => {
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

  await rig.cleanup();
});

test('2 tasks: run, cached, run, cached', async () => {
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

  await rig.cleanup();
});

test('2 tasks: run, cached, run, cached', async () => {
  const rig = new TestRig();
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

  await rig.cleanup();
});

test.run();
