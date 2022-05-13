/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {timeout} from './util/uvu-timeout.js';
import {WireitTestRig} from './util/test-rig.js';

const test = suite<{rig: WireitTestRig}>();

test.before.each(async (ctx) => {
  try {
    ctx.rig = new WireitTestRig();
    await ctx.rig.setup();
  } catch (error) {
    // Uvu has a bug where it silently ignores failures in before and after,
    // see https://github.com/lukeed/uvu/issues/191.
    console.error('uvu before error', error);
    process.exit(1);
  }
});

test.after.each(async (ctx) => {
  try {
    await ctx.rig.cleanup();
  } catch (error) {
    // Uvu has a bug where it silently ignores failures in before and after,
    // see https://github.com/lukeed/uvu/issues/191.
    console.error('uvu after error', error);
    process.exit(1);
  }
});

test(
  'runs one script that fails',
  timeout(async ({rig}) => {
    const cmdA = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
          },
        },
      },
    });
    const exec = rig.exec('npm run a');

    const invA = await cmdA.nextInvocation();
    invA.stdout('a stdout');
    invA.stderr('a stderr');
    invA.exit(1);

    const res = await exec.exit;
    assert.equal(res.code, 1);
    assert.equal(cmdA.numInvocations, 1);
    assert.match(res.stdout, 'a stdout');
    assert.match(res.stderr, 'a stderr');
  })
);

test(
  'dependency chain in one package that fails in the middle',
  timeout(async ({rig}) => {
    // a --> b* --> c
    const cmdA = await rig.newCommand();
    const cmdB = await rig.newCommand();
    const cmdC = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
          c: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            dependencies: ['b'],
          },
          b: {
            command: cmdB.command,
            dependencies: ['c'],
          },
          c: {
            command: cmdC.command,
          },
        },
      },
    });
    const exec = rig.exec('npm run a');

    const invC = await cmdC.nextInvocation();
    invC.exit(0);

    const invB = await cmdB.nextInvocation();
    invB.exit(42);

    const res = await exec.exit;
    assert.equal(res.code, 1);
    assert.equal(cmdA.numInvocations, 0);
    assert.equal(cmdB.numInvocations, 1);
    assert.equal(cmdC.numInvocations, 1);
  })
);

test(
  'dependency chain in one package that fails in nested dependency',
  timeout(async ({rig}) => {
    const cmdA = await rig.newCommand();
    const cmdB = await rig.newCommand();
    const cmdC = await rig.newCommand();
    const cmdD = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
          c: 'wireit',
          d: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            dependencies: ['b'],
          },
          b: {
            command: cmdB.command,
            dependencies: ['c', 'd'],
          },
          c: {
            command: cmdC.command,
          },
          d: {
            command: cmdD.command,
          },
        },
      },
    });

    const exec = rig.exec('npm run a');

    const invD = await cmdD.nextInvocation();
    invD.exit(808);

    const invC = await cmdC.nextInvocation();
    invC.exit(303);

    const res = await exec.exit;
    assert.equal(res.code, 1);
    assert.equal(cmdA.numInvocations, 0);
    assert.equal(cmdB.numInvocations, 0);
    assert.equal(cmdC.numInvocations, 1);
    assert.equal(cmdD.numInvocations, 1);
  })
);

for (const envSetting of ['no-new', undefined]) {
  test(
    `don't start new script after unrelated failure when WIREIT_FAILURES=${
      envSetting ?? '<unset>'
    }`,
    timeout(async ({rig}) => {
      //   main
      //    / \
      //   |   \
      //   |    v
      //   |  failParent
      //   |    /  \
      //   |   |    |
      //   |   v    |
      //   |  fail  |
      //   |        v
      //   |    failParentBlocker
      //   v
      // cancel
      //   |
      //   v
      // cancelBlocker

      /**
       * The script that will fail.
       */
      const fail = await rig.newCommand();

      /**
       * The script that we expect to be cancelled.
       *
       * It's important that this script does not depend on the one that fails,
       * because that would be the easy case.
       */
      const cancel = await rig.newCommand();

      /**
       * Gives us control over when the `cancel` script starts.
       */
      const cancelBlocker = await rig.newCommand();

      /**
       * Gives us control over when the `failParent` script resolves.
       */
      const failParentBlocker = await rig.newCommand();

      await rig.write({
        'package.json': {
          scripts: {
            main: 'wireit',
            failParent: 'wireit',
            failParentBlocker: 'wireit',
            fail: 'wireit',
            cancel: 'wireit',
            cancelBlocker: 'wireit',
          },
          wireit: {
            main: {
              dependencies: ['failParent', 'cancel'],
            },
            failParent: {
              dependencies: ['fail', 'failParentBlocker'],
            },
            failParentBlocker: {
              command: failParentBlocker.command,
            },
            fail: {
              command: fail.command,
            },
            cancel: {
              command: cancel.command,
              dependencies: ['cancelBlocker'],
            },
            cancelBlocker: {
              command: cancelBlocker.command,
            },
          },
        },
      });

      const wireit = rig.exec('npm run main', {
        env: {
          WIREIT_FAILURES: envSetting,
        },
      });

      // `fail`, `failParentBlocker`, and `cancelBlocker` start
      const failInv = await fail.nextInvocation();
      const failParentBlockerInv = await failParentBlocker.nextInvocation();
      const cancelBlockerInv = await cancelBlocker.nextInvocation();

      // The failure occurs.
      failInv.exit(1);

      // Unblock `cancel`. It could start, but it shouldn't, because a failure has
      // occured elsewhere in the graph. Wait a moment first to ensure Wireit
      // notices the failure before we unblock.
      await new Promise((resolve) => setTimeout(resolve, 50));
      cancelBlockerInv.exit(0);

      // Unblock `failParent`. We do this after unblocking `cancel` so that we
      // cover the case where the branch that failed has not yet reached the root
      // of the graph, because it's easy to imagine an implementation that relies
      // on that. Wait a moment first to ensure Wireit unblocks `cancel` before
      // it unblocks `failParent`.
      await new Promise((resolve) => setTimeout(resolve, 50));
      failParentBlockerInv.exit(0);

      assert.equal((await wireit.exit).code, 1);
      assert.equal(fail.numInvocations, 1);
      assert.equal(failParentBlocker.numInvocations, 1);
      assert.equal(cancel.numInvocations, 0);
      assert.equal(cancelBlocker.numInvocations, 1);
    })
  );
}

test(
  "don't start new script after unrelated failure with constrained parallelism in no-new mode",
  timeout(async ({rig}) => {
    // This test covers handling for a race condition that occurs where the
    // WorkerPool might release a slot and let the next script start before a
    // failure has asynchronously propagated to the Executor.

    //    main
    //    / \
    //   |   v
    //   |  fail
    //   v
    // cancel

    const a = await rig.newCommand();
    const b = await rig.newCommand();

    await rig.write({
      'package.json': {
        scripts: {
          main: 'wireit',
          a: 'wireit',
          b: 'wireit',
        },
        wireit: {
          main: {
            dependencies: ['a', 'b'],
          },
          a: {
            command: a.command,
          },
          b: {
            command: b.command,
          },
        },
      },
    });

    const wireit = rig.exec('npm run main', {
      env: {
        WIREIT_PARALLEL: '1',
      },
    });

    // First one fails (doesn't matter which).
    const first = await Promise.race([a.nextInvocation(), b.nextInvocation()]);
    first.exit(1);

    // Cancel is now unblocked because there is a free worker pool slot, so it
    // could start. But there was a failure elsewhere in the build, so it
    // shouldn't.

    assert.equal((await wireit.exit).code, 1);

    if (a.numInvocations === 1) {
      assert.equal(a.numInvocations, 1);
      assert.equal(b.numInvocations, 0);
    } else {
      assert.equal(a.numInvocations, 0);
      assert.equal(b.numInvocations, 1);
    }
  })
);

test(
  'allow unrelated scripts to start after failure in continue mode',
  timeout(async ({rig}) => {
    //   main
    //    /\
    //   |  |
    //   |  v
    //   | fail
    //   v
    // continues
    //   |
    //   v
    // continuesBlocker

    const fail = await rig.newCommand();
    const continues = await rig.newCommand();
    const continuesBlocker = await rig.newCommand();

    await rig.write({
      'package.json': {
        scripts: {
          main: 'wireit',
          fail: 'wireit',
          continues: 'wireit',
          continuesBlocker: 'wireit',
        },
        wireit: {
          main: {
            dependencies: ['continues', 'fail'],
          },
          fail: {
            command: fail.command,
          },
          continues: {
            command: continues.command,
            dependencies: ['continuesBlocker'],
          },
          continuesBlocker: {
            command: continuesBlocker.command,
          },
        },
      },
    });

    const wireit = rig.exec('npm run main', {
      env: {
        WIREIT_FAILURES: 'continue',
      },
    });

    // `fail` and `continuesBlocker` start
    const failInv = await fail.nextInvocation();
    const continuesBlockerInv = await continuesBlocker.nextInvocation();

    // The failure occurs.
    failInv.exit(1);

    // Unblock `continues`. Even though there was a failure, it still starts,
    // because we're in "continue" mode. Wait a moment first to ensure Wireit
    // notices the failure before we unblock.
    await new Promise((resolve) => setTimeout(resolve, 50));
    continuesBlockerInv.exit(0);
    const continuesInv = await continues.nextInvocation();
    continuesInv.exit(0);

    assert.equal((await wireit.exit).code, 1);
    assert.equal(fail.numInvocations, 1);
    assert.equal(continues.numInvocations, 1);
    assert.equal(continuesBlocker.numInvocations, 1);
  })
);

test(
  'kill running script after failure in kill mode',
  timeout(async ({rig}) => {
    //   main
    //    / \
    //   |   |
    //   |   v
    //   |  fail
    //   v
    // kill

    const fail = await rig.newCommand();
    const kill = await rig.newCommand();

    await rig.write({
      'package.json': {
        scripts: {
          main: 'wireit',
          fail: 'wireit',
          kill: 'wireit',
        },
        wireit: {
          main: {
            dependencies: ['kill', 'fail'],
          },
          fail: {
            command: fail.command,
          },
          kill: {
            command: kill.command,
          },
        },
      },
    });

    const wireit = rig.exec('npm run main', {
      env: {
        WIREIT_FAILURES: 'kill',
      },
    });

    // `fail` and `kill` start
    const failInv = await fail.nextInvocation();
    await kill.nextInvocation();

    // The failure occurs.
    failInv.exit(1);

    // `kill` is killed.
    assert.equal((await wireit.exit).code, 1);
  })
);

test.run();
