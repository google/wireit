import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {TestRig} from './util/test-rig.js';
import {timeout} from './util/uvu-timeout.js';
import {FakeGitHubCacheServer} from './util/fake-github-cache-server.js';
import * as pathlib from 'path';

const test = suite<{rig: TestRig; gh: FakeGitHubCacheServer}>();

test.before.each(async (ctx) => {
  ctx.rig = new TestRig();
  ctx.gh = new FakeGitHubCacheServer();
  await Promise.all([ctx.rig.setup(), ctx.gh.listen(3030)]);
  process.env.ACTIONS_CACHE_URL = `http://localhost:3030/`;
  process.env.RUNNER_TEMP = pathlib.join(ctx.rig.tempDir, 'github-cache-temp');
});

test.after.each(async (ctx) => {
  await Promise.all([ctx.gh.close(), ctx.rig.cleanup()]);
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
      const out = rig.exec('GITHUB_CACHE=1 npm run cmd');
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
      const out = rig.exec('GITHUB_CACHE=1 npm run cmd');
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
      const out = rig.exec('GITHUB_CACHE=1 npm run cmd');
      const {code} = await out.done;
      assert.equal(code, 0);
      assert.equal(await rig.readFile('output.txt'), 'v0');
      assert.equal(cmd.startedCount, 2);
    }

    // Run with input v1 again. We should not need to run the command, because
    // we already have the output of v1 cached.
    {
      await rig.writeFiles({'input.txt': 'v1'});
      const out = rig.exec('GITHUB_CACHE=1 npm run cmd');
      const {code} = await out.done;
      assert.equal(code, 0);
      assert.equal(await rig.readFile('output.txt'), 'v1');
      assert.equal(cmd.startedCount, 2);
    }
  })
);

test.run();
