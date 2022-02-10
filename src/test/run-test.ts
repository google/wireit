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
  '1 script succeeds',
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
          },
        },
      },
    });
    const out = rig.exec('npm run cmd');
    await cmd.waitUntilStarted();
    await cmd.exit(0);
    const {code} = await out.done;
    assert.equal(code, 0);
  })
);

test(
  'runs node binaries when invoked via npm script',
  timeout(async ({rig}) => {
    const cmd = rig.newCommand();
    await rig.writeFiles({
      'package.json': {
        scripts: {
          cmd: 'wireit',
        },
        wireit: {
          cmd: {
            command: 'installed-binary',
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
  })
);

test(
  'runs node binaries when invoked directly',
  timeout(async ({rig}) => {
    const cmd = rig.newCommand();
    await rig.writeFiles({
      'package.json': {
        scripts: {
          cmd: 'wireit',
        },
        wireit: {
          cmd: {
            command: 'installed-binary',
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
  })
);

test(
  '1 script fails',
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
          },
        },
      },
    });
    const out = rig.exec('npm run cmd');
    await cmd.waitUntilStarted();
    await cmd.exit(37); // Specific code doesn't matter.
    const {code} = await out.done;
    assert.equal(code, 1, 'code');
    assert.equal(cmd.startedCount, 1);
  })
);

test(
  '2 scripts, 2 succeed',
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
            dependencies: ['cmd2'],
          },
          cmd2: {
            command: cmd2.command(),
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
  })
);

test(
  '2 scripts, first fails',
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
            dependencies: ['cmd2'],
          },
          cmd2: {
            command: cmd2.command(),
          },
        },
      },
    });

    const out = rig.exec('npm run cmd1');

    await cmd2.waitUntilStarted();
    await cmd2.exit(37);

    // Fail because a script failed
    const {code} = await out.done;
    assert.equal(code, 1);

    // cmd1 should never have started
    await rig.sleep(50);
    assert.not(cmd1.running);
    assert.equal(cmd1.startedCount, 0);
    assert.equal(cmd2.startedCount, 1);
  })
);

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
test(
  'diamond',
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
  })
);

test(
  'cross package',
  timeout(async ({rig}) => {
    const cmd1 = rig.newCommand();
    const cmd2 = rig.newCommand();
    await rig.writeFiles({
      'pkg1/package.json': {
        scripts: {
          cmd1: 'wireit',
        },
        wireit: {
          cmd1: {
            command: cmd1.command(),
            dependencies: ['../pkg2:cmd2'],
          },
        },
      },
      'pkg2/package.json': {
        scripts: {
          cmd2: 'wireit',
        },
        wireit: {
          cmd2: {
            command: cmd2.command(),
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
  })
);

test(
  'vanilla script dependency',
  timeout(async ({rig}) => {
    const cmd1 = rig.newCommand();
    const cmd2 = rig.newCommand();
    await rig.writeFiles({
      'package.json': {
        scripts: {
          cmd1: 'wireit',
          cmd2: cmd2.command(),
        },
        wireit: {
          cmd1: {
            command: cmd1.command(),
            dependencies: ['cmd2'],
          },
        },
      },
    });
    const out = rig.exec('npm run cmd1');
    await cmd2.waitUntilStarted();
    await cmd2.exit(0);
    await cmd1.waitUntilStarted();
    await cmd1.exit(0);
    const {code} = await out.done;
    assert.equal(code, 0);
    assert.equal(cmd1.startedCount, 1);
    assert.equal(cmd2.startedCount, 1);
  })
);

test(
  'detects cycles of length 1',
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
            dependencies: ['cmd'],
          },
        },
      },
    });
    const out = rig.exec('npm run cmd');
    const {code} = await out.done;
    await rig.sleep(50);
    assert.equal(cmd.startedCount, 0);
    assert.equal(code, 1);
  })
);

test(
  'detects cycles of length 2',
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
            dependencies: ['cmd2'],
          },
          cmd2: {
            command: cmd2.command(),
            dependencies: ['cmd1'],
          },
        },
      },
    });
    const out = rig.exec('npm run cmd1');
    const {code} = await out.done;
    await rig.sleep(50);
    assert.equal(cmd1.startedCount, 0);
    assert.equal(cmd2.startedCount, 0);
    assert.equal(code, 1);
  })
);

test(
  'SIGINT waits for children to exit',
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
    const process = rig.exec('npm run cmd1');

    // The two dependency processes should start in parallel.
    await cmd2.waitUntilStarted();
    await cmd3.waitUntilStarted();

    // Now we send SIGINT to the main wireit process.

    // TODO(aomarks) We must grab these promises first, or else there's a race
    // condition where we reset the promise before we have a chance to grab it.
    // Better API?
    const signal1 = cmd2.receivedSignal;
    const signal2 = cmd3.receivedSignal;
    process.kill('SIGINT');

    // Both dependency processes should receive this.
    assert.equal(await signal1, 'SIGINT');
    assert.equal(await signal2, 'SIGINT');

    // Child 1/1, but we can't exit yet because 2/2 is still running.
    await cmd2.exit(1);
    await rig.sleep(50);
    assert.equal(process.running(), true);

    // Child 2/2 exits
    await cmd3.exit(1);

    // Now the main process can exit.
    const {code} = await process.done;
    assert.equal(code, 130);

    // cmd1 should never have started, the other two started once each.
    assert.equal(cmd1.startedCount, 0);
    assert.equal(cmd2.startedCount, 1);
    assert.equal(cmd3.startedCount, 1);
  })
);

test.run();
