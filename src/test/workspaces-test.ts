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
  '$WORKSPACES dependency refers to all package workspaces with same script name',
  timeout(async ({rig}) => {
    const cmd1 = rig.newCommand();
    const cmd2 = rig.newCommand();
    const other1 = rig.newCommand();
    const excluded = rig.newCommand();
    await rig.writeFiles({
      'package.json': {
        scripts: {
          cmd: 'wireit',
        },
        wireit: {
          cmd: {
            dependencies: [
              // All "cmd" scripts in this package's workspaces.
              '$WORKSPACES',
              // All "other" scripts in this package's workspcaes.
              '$WORKSPACES:other',
            ],
          },
        },
        workspaces: [
          'packages/*',
          // Make sure negations work by adding this special case that isn't in
          // our workspaces list.
          '!packages/pkg3',
        ],
      },
      'packages/pkg1/package.json': {
        scripts: {
          cmd: 'wireit',
          other: 'wireit',
        },
        wireit: {
          cmd: {
            command: cmd1.command(),
          },
          other: {
            command: other1.command(),
          },
        },
      },
      'packages/pkg2/package.json': {
        scripts: {
          cmd: 'wireit',
          // No "other" command here. It will be ignored.
        },
        wireit: {
          cmd: {
            command: cmd2.command(),
          },
        },
      },
      'packages/pkg3/package.json': {
        scripts: {
          cmd: 'wireit',
        },
        wireit: {
          cmd: {
            command: excluded.command(),
          },
        },
      },
    });
    const out = rig.exec('npm run cmd');
    await cmd1.waitUntilStarted();
    await cmd2.waitUntilStarted();
    await other1.waitUntilStarted();
    await cmd1.exit(0);
    await cmd2.exit(0);
    await other1.exit(0);
    const {code} = await out.done;
    assert.equal(code, 0);
    assert.equal(cmd1.startedCount, 1);
    assert.equal(cmd2.startedCount, 1);
    assert.equal(other1.startedCount, 1);
    assert.equal(excluded.startedCount, 0);
  })
);

test.run();
