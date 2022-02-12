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
  'script output is cached',
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
            output: ['output.txt'],
          },
        },
      },
      'input.txt': 'v0',
    });

    // Run with input v0.
    {
      const out = rig.exec('npm run cmd');
      await cmd.waitUntilStarted();
      await rig.writeFiles({'output.txt': 'v0'});
      await cmd.exit(0);
      const {code} = await out.done;
      assert.equal(code, 0);
      assert.equal(cmd.startedCount, 1);
    }

    // Run with input v1.
    {
      await rig.writeFiles({'input.txt': 'v1'});
      const out = rig.exec('npm run cmd');
      await cmd.waitUntilStarted();
      await rig.writeFiles({'output.txt': 'v1'});
      await cmd.exit(0);
      const {code} = await out.done;
      assert.equal(code, 0);
      assert.equal(cmd.startedCount, 2);
    }

    // Run with input v0 again. We should not need to run the command, because
    // we already have the output of v0 cached.
    {
      await rig.writeFiles({'input.txt': 'v0'});
      const out = rig.exec('npm run cmd');
      const {code} = await out.done;
      assert.equal(code, 0);
      assert.equal(await rig.readFile('output.txt'), 'v0');
      assert.equal(cmd.startedCount, 2);
    }

    // Run with input v1 again. We should not need to run the command, because
    // we already have the output of v1 cached.
    {
      await rig.writeFiles({'input.txt': 'v1'});
      const out = rig.exec('npm run cmd');
      const {code} = await out.done;
      assert.equal(code, 0);
      assert.equal(await rig.readFile('output.txt'), 'v1');
      assert.equal(cmd.startedCount, 2);
    }
  })
);

test(
  'script with empty output is cached',
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
            output: [],
          },
        },
      },
      'input.txt': 'v0',
    });

    // Run with input v0.
    {
      const out = rig.exec('npm run cmd');
      await cmd.waitUntilStarted();
      await cmd.exit(0);
      const {code} = await out.done;
      assert.equal(code, 0);
      assert.equal(cmd.startedCount, 1);
    }

    // Run with input v1.
    {
      await rig.writeFiles({'input.txt': 'v1'});
      const out = rig.exec('npm run cmd');
      await cmd.waitUntilStarted();
      await cmd.exit(0);
      const {code} = await out.done;
      assert.equal(code, 0);
      assert.equal(cmd.startedCount, 2);
    }

    // Run with input v0 again. We should not need to run the command, because
    // we already have the output of v0 cached.
    {
      await rig.writeFiles({'input.txt': 'v0'});
      const out = rig.exec('npm run cmd');
      const {code} = await out.done;
      assert.equal(code, 0);
      assert.equal(cmd.startedCount, 2);
    }

    // Run with input v1 again. We should not need to run the command, because
    // we already have the output of v1 cached.
    {
      await rig.writeFiles({'input.txt': 'v1'});
      const out = rig.exec('npm run cmd');
      const {code} = await out.done;
      assert.equal(code, 0);
      assert.equal(cmd.startedCount, 2);
    }
  })
);

test(
  'script with undefined output is not cached',
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
      'input.txt': 'v0',
    });

    // Run with input v0.
    {
      const out = rig.exec('npm run cmd');
      await cmd.waitUntilStarted();
      await cmd.exit(0);
      const {code} = await out.done;
      assert.equal(code, 0);
      assert.equal(cmd.startedCount, 1);
    }

    // Run with input v1 (so that v0 is not fresh).
    {
      await rig.writeFiles({'input.txt': 'v1'});
      const out = rig.exec('npm run cmd');
      await cmd.waitUntilStarted();
      await cmd.exit(0);
      const {code} = await out.done;
      assert.equal(code, 0);
      assert.equal(cmd.startedCount, 2);
    }

    // Run with input v0 again. If output was defined (even an empty array),
    // then we would restore from cache here. But since it isn't, we assume that
    // there could be output we weren't aware of, and err on the side of safety
    // by executing again.
    {
      await rig.writeFiles({'input.txt': 'v0'});
      const out = rig.exec('npm run cmd');
      await cmd.waitUntilStarted();
      await cmd.exit(0);
      const {code} = await out.done;
      assert.equal(code, 0);
      assert.equal(cmd.startedCount, 3);
    }
  })
);

test(
  'filesystem cache globs match dotfiles',
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
            output: ['out/**'],
          },
        },
      },
      'input.txt': 'v0',
    });

    // Run with input v0.
    {
      const out = rig.exec('npm run cmd');
      await cmd.waitUntilStarted();
      await rig.writeFiles({'out/.dotfile': 'v0'});
      await cmd.exit(0);
      const {code} = await out.done;
      assert.equal(code, 0);
      assert.equal(cmd.startedCount, 1);
    }

    // Run with input v1.
    {
      await rig.writeFiles({'input.txt': 'v1'});
      const out = rig.exec('npm run cmd');
      await cmd.waitUntilStarted();
      await rig.writeFiles({'out/.dotfile': 'v1'});
      await cmd.exit(0);
      const {code} = await out.done;
      assert.equal(code, 0);
      assert.equal(cmd.startedCount, 2);
    }

    // Run with input v0 again. We should not need to run the command, because
    // we already have the output of v0 cached.
    {
      await rig.writeFiles({'input.txt': 'v0'});
      const out = rig.exec('npm run cmd');
      const {code} = await out.done;
      assert.equal(code, 0);
      assert.equal(await rig.readFile('out/.dotfile'), 'v0');
      assert.equal(cmd.startedCount, 2);
    }

    // Run with input v1 again. We should not need to run the command, because
    // we already have the output of v1 cached.
    {
      await rig.writeFiles({'input.txt': 'v1'});
      const out = rig.exec('npm run cmd');
      const {code} = await out.done;
      assert.equal(code, 0);
      assert.equal(await rig.readFile('out/.dotfile'), 'v1');
      assert.equal(cmd.startedCount, 2);
    }
  })
);

test.run();
