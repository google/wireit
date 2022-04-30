/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {timeout, wait} from './util/uvu-timeout.js';
import {WireitTestRig} from './util/test-rig.js';
import * as os from 'os';

import type {PackageJson} from './util/package-json.js';

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
  'by default we run dependencies in parallel',
  timeout(async ({rig}) => {
    // Note the test rig set WIREIT_PARALLELISM to 10 by default, even though
    // the real default is based on CPU count.
    const dep1 = await rig.newCommand();
    const dep2 = await rig.newCommand();
    const main = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          dep1: 'wireit',
          dep2: 'wireit',
          main: 'wireit',
        },
        wireit: {
          dep1: {command: dep1.command},
          dep2: {command: dep2.command},
          main: {command: main.command, dependencies: ['dep1', 'dep2']},
        },
      },
    });

    {
      const exec = rig.exec('npm run main');
      // The two deps are invoked immediately, but main isn't
      const [inv1, inv2] = await Promise.all([
        dep1.nextInvocation(),
        dep2.nextInvocation(),
      ]);
      assert.equal(main.numInvocations, 0);
      inv1.exit(0);
      inv2.exit(0);
      // now main is invoked, and the command exits
      (await main.nextInvocation()).exit(0);
      const res = await exec.exit;
      assert.equal(res.code, 0);
      assert.equal(dep1.numInvocations, 1);
      assert.equal(dep2.numInvocations, 1);
      assert.equal(main.numInvocations, 1);
    }
  })
);

test(
  'can set WIREIT_PARALLEL=1 to run sequentially',
  timeout(async ({rig}) => {
    const dep1 = await rig.newCommand();
    const dep2 = await rig.newCommand();
    const main = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          dep1: 'wireit',
          dep2: 'wireit',
          main: 'wireit',
        },
        wireit: {
          dep1: {command: dep1.command},
          dep2: {command: dep2.command},
          main: {command: main.command, dependencies: ['dep1', 'dep2']},
        },
      },
    });

    const exec = rig.exec('npm run main', {env: {WIREIT_PARALLEL: '1'}});
    // One of the two deps are invoked first
    const dep1InvPromise = dep1.nextInvocation();
    const dep2InvPromise = dep2.nextInvocation();
    // wait for the first command to begin
    const luckyInv = await Promise.race([dep1InvPromise, dep2InvPromise]);
    // wait for a bit, to show that the other command does not begin
    await wait(300);
    let unluckyInvPromise;
    if (luckyInv.command === dep1) {
      unluckyInvPromise = dep2InvPromise;
      assert.equal(dep1.numInvocations, 1);
      assert.equal(dep2.numInvocations, 0);
    } else {
      unluckyInvPromise = dep1InvPromise;
      assert.equal(dep1.numInvocations, 0);
      assert.equal(dep2.numInvocations, 1);
    }
    assert.equal(main.numInvocations, 0);
    // once the lucky dep finishes, the unlucky one is invoked
    luckyInv.exit(0);
    (await unluckyInvPromise).exit(0);
    // and then finally main is invoked and the command exits
    (await main.nextInvocation()).exit(0);
    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(dep1.numInvocations, 1);
    assert.equal(dep2.numInvocations, 1);
    assert.equal(main.numInvocations, 1);
  })
);

test(
  'can set WIREIT_PARALLEL=Infinity to run many commands in parallel',
  timeout(async ({rig}) => {
    const main = await rig.newCommand();
    // Pick a number of scripts that we will expect to run simultaneously which is
    // higher than the default of CPUs x 4, to show that we have increased beyond
    // that default.
    const n = os.cpus().length * 10;
    const depNames: string[] = [];
    const packageJson: PackageJson = {
      scripts: {
        main: 'wireit',
      },
      wireit: {
        main: {command: main.command, dependencies: depNames},
      },
    };
    const commands = [];
    const invocations = [];
    for (let i = 0; i < n; i++) {
      const command = await rig.newCommand();
      commands.push(command);
      const name = `dep${i}`;
      depNames.push(name);

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      packageJson.scripts![name] = 'wireit';
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      packageJson.wireit![name] = {command: command.command};
      invocations.push(command.nextInvocation());
    }

    await rig.write({
      'package.json': packageJson,
    });

    const exec = rig.exec('npm run main', {env: {WIREIT_PARALLEL: 'Infinity'}});
    // All invocations should be started simultaneously
    const started = await Promise.all(invocations);
    for (const invocation of started) {
      invocation.exit(0);
    }
    // once they're all done, main still finishes normally
    (await main.nextInvocation()).exit(0);
    const res = await exec.exit;
    assert.equal(res.code, 0);
    for (const cmd of commands) {
      assert.equal(cmd.numInvocations, 1);
    }
    assert.equal(main.numInvocations, 1);
  })
);

test(
  'should fall back to default parallelism with empty WIREIT_PARALLEL',
  timeout(async ({rig}) => {
    const dep1 = await rig.newCommand();
    const dep2 = await rig.newCommand();
    const main = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          dep1: 'wireit',
          dep2: 'wireit',
          main: 'wireit',
        },
        wireit: {
          dep1: {command: dep1.command},
          dep2: {command: dep2.command},
          main: {command: main.command, dependencies: ['dep1', 'dep2']},
        },
      },
    });

    const exec = rig.exec('npm run main', {env: {WIREIT_PARALLEL: ''}});
    const [inv1, inv2] = await Promise.all([
      dep1.nextInvocation(),
      dep2.nextInvocation(),
    ]);
    assert.equal(main.numInvocations, 0);
    inv1.exit(0);
    inv2.exit(0);
    (await main.nextInvocation()).exit(0);
    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(dep1.numInvocations, 1);
    assert.equal(dep2.numInvocations, 1);
    assert.equal(main.numInvocations, 1);
  })
);

test.run();
