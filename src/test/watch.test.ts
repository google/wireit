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
  'runs initially and waits for SIGINT',
  timeout(async ({rig}) => {
    const cmdA = await rig.newCommand();
    await rig.writeAtomic({
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

    // Initial execution.
    const exec = rig.exec('npm run a watch');
    const inv = await cmdA.nextInvocation();
    inv.exit(0);

    // It's important in these test cases that after we tell a script process to
    // exit, we wait for its socket to close, indicating that it received the
    // message and has exited (or is in the process of exiting). Otherwise, when
    // we then send a kill signal to the parent Wireit process, the Wireit
    // process might kill the script child process before our message has been
    // transferred, which will raise an uncaught ECONNRESET error in these
    // tests.
    //
    // TODO(aomarks) Waiting for the socket write callback seems like it should
    // be sufficient to prevent this error, but it isn't. Investigate why that
    // is, and consider instead sending explicit ACK messages back from the
    // child process.
    await inv.closed;

    // Wait a while to check that the Wireit process remains running, waiting
    // for file changes or a signal.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(exec.running);

    // Should exit after a SIGINT signal (i.e. Ctrl-C).
    exec.kill();
    await exec.exit;
    assert.equal(cmdA.numInvocations, 1);
  })
);

test(
  'runs again when input file changes after execution',
  timeout(async ({rig}) => {
    const cmdA = await rig.newCommand();
    await rig.writeAtomic({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            files: ['input.txt'],
          },
        },
      },
      'input.txt': 'v0',
    });

    const exec = rig.exec('npm run a watch');

    // Initial run.
    {
      const inv = await cmdA.nextInvocation();
      inv.exit(0);
    }

    // Changing an input file should cause another run.
    {
      await rig.writeAtomic({
        'input.txt': 'v1',
      });
      const inv = await cmdA.nextInvocation();
      inv.exit(0);
      await inv.closed;
    }

    exec.kill();
    await exec.exit;
    assert.equal(cmdA.numInvocations, 2);
  })
);

test(
  'runs again when new input file created',
  timeout(async ({rig}) => {
    const cmdA = await rig.newCommand();
    await rig.writeAtomic({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            files: ['input*.txt'],
          },
        },
      },
      'input1.txt': 'v0',
    });

    const exec = rig.exec('npm run a watch');

    // Initial run.
    {
      const inv = await cmdA.nextInvocation();
      inv.exit(0);
    }

    // Adding another input file should cause another run.
    {
      await rig.writeAtomic({
        'input2.txt': 'v0',
      });
      const inv = await cmdA.nextInvocation();
      inv.exit(0);
      await inv.closed;
    }

    exec.kill();
    await exec.exit;
    assert.equal(cmdA.numInvocations, 2);
  })
);

test(
  'runs again when input file deleted',
  timeout(async ({rig}) => {
    const cmdA = await rig.newCommand();
    await rig.writeAtomic({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            files: ['input'],
          },
        },
      },
      input: 'v0',
    });

    const exec = rig.exec('npm run a watch');

    // Initial run.
    {
      const inv = await cmdA.nextInvocation();
      inv.exit(0);
    }

    // Deleting the input file should cause another run.
    {
      await rig.delete('input');
      const inv = await cmdA.nextInvocation();
      inv.exit(0);
      await inv.closed;
    }

    exec.kill();
    await exec.exit;
    assert.equal(cmdA.numInvocations, 2);
  })
);

test(
  'runs again when input file changes in the middle of execution',
  timeout(async ({rig}) => {
    const cmdA = await rig.newCommand();
    await rig.writeAtomic({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            files: ['input.txt'],
          },
        },
      },
      'input.txt': 'v0',
    });

    const exec = rig.exec('npm run a watch');

    // Initial run.
    {
      const inv = await cmdA.nextInvocation();
      // Change the input while the first invocation is still running.
      await rig.writeAtomic({
        'input.txt': 'v1',
      });
      inv.exit(0);
    }

    // Expect another invocation to have been queued up.
    {
      const inv = await cmdA.nextInvocation();
      inv.exit(0);
      await inv.closed;
    }

    exec.kill();
    await exec.exit;
    assert.equal(cmdA.numInvocations, 2);
  })
);

test(
  'reloads config when package.json changes and runs again',
  timeout(async ({rig}) => {
    const cmdA1 = await rig.newCommand();
    const cmdA2 = await rig.newCommand();
    await rig.writeAtomic({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA1.command,
          },
        },
      },
    });

    const exec = rig.exec('npm run a watch');

    // Initial run.
    {
      const inv = await cmdA1.nextInvocation();
      inv.exit(0);
    }

    // Change the command of the script we are running by re-writing the
    // package.json. That change should be detected, the new config should be
    // analyzed, and the new command should run.
    {
      await rig.writeAtomic({
        'package.json': {
          scripts: {
            a: 'wireit',
          },
          wireit: {
            a: {
              command: cmdA2.command,
            },
          },
        },
      });
      const inv = await cmdA2.nextInvocation();
      inv.exit(0);
      await inv.closed;
    }

    exec.kill();
    await exec.exit;
    assert.equal(cmdA1.numInvocations, 1);
    assert.equal(cmdA2.numInvocations, 1);
  })
);

test(
  'changes are detected in same-package dependencies',
  timeout(async ({rig}) => {
    const cmdA = await rig.newCommand();
    const cmdB = await rig.newCommand();
    await rig.writeAtomic({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            dependencies: ['b'],
            files: ['a.txt'],
          },
          b: {
            command: cmdB.command,
            files: ['b.txt'],
          },
        },
      },
      'a.txt': 'v0',
      'b.txt': 'v0',
    });

    const exec = rig.exec('npm run a watch');

    // Both scripts run initially.
    {
      const invB = await cmdB.nextInvocation();
      invB.exit(0);
      const invA = await cmdA.nextInvocation();
      invA.exit(0);
      assert.equal(cmdA.numInvocations, 1);
      assert.equal(cmdB.numInvocations, 1);
    }

    // Changing an input of A should cause A to run again, but not B.
    {
      await rig.writeAtomic({
        'a.txt': 'v1',
      });
      const invA = await cmdA.nextInvocation();
      invA.exit(0);
      assert.equal(cmdA.numInvocations, 2);
      assert.equal(cmdB.numInvocations, 1);
    }

    // Changing an input of B should cause both scripts to run.
    {
      await rig.writeAtomic({
        'b.txt': 'v1',
      });
      const invB = await cmdB.nextInvocation();
      invB.exit(0);
      const invA = await cmdA.nextInvocation();
      invA.exit(0);
      await invA.closed;
      await invB.closed;
    }

    exec.kill();
    await exec.exit;
    assert.equal(cmdA.numInvocations, 3);
    assert.equal(cmdB.numInvocations, 2);
  })
);

test(
  'changes are detected in cross-package dependencies',
  timeout(async ({rig}) => {
    const cmdA = await rig.newCommand();
    const cmdB = await rig.newCommand();
    await rig.writeAtomic({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            dependencies: ['../bar:b'],
            files: ['a.txt'],
          },
        },
      },
      'foo/a.txt': 'v0',
      'bar/package.json': {
        scripts: {
          b: 'wireit',
        },
        wireit: {
          b: {
            command: cmdB.command,
            files: ['b.txt'],
          },
        },
      },
      'bar/b.txt': 'v0',
    });

    const exec = rig.exec('npm run a watch', {cwd: 'foo'});

    // Both scripts run initially.
    {
      const invB = await cmdB.nextInvocation();
      invB.exit(0);
      const invA = await cmdA.nextInvocation();
      invA.exit(0);
      assert.equal(cmdA.numInvocations, 1);
      assert.equal(cmdB.numInvocations, 1);
    }

    // Changing an input of A should cause A to run again, but not B.
    {
      await rig.writeAtomic({
        'foo/a.txt': 'v1',
      });
      const invA = await cmdA.nextInvocation();
      invA.exit(0);
      assert.equal(cmdA.numInvocations, 2);
      assert.equal(cmdB.numInvocations, 1);
    }

    // Changing an input of B should cause both scripts to run.
    {
      await rig.writeAtomic({
        'bar/b.txt': 'v1',
      });
      const invB = await cmdB.nextInvocation();
      invB.exit(0);
      const invA = await cmdA.nextInvocation();
      invA.exit(0);
      await invA.closed;
      await invB.closed;
    }

    exec.kill();
    await exec.exit;
    assert.equal(cmdA.numInvocations, 3);
    assert.equal(cmdB.numInvocations, 2);
  })
);

test(
  'error from script is not fatal',
  timeout(async ({rig}) => {
    const cmdA = await rig.newCommand();
    await rig.writeAtomic({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            files: ['a.txt'],
          },
        },
      },
      'a.txt': 'v0',
    });

    const exec = rig.exec('npm run a watch');

    // Script fails initially.
    {
      const inv = await cmdA.nextInvocation();
      inv.exit(1);
      assert.equal(cmdA.numInvocations, 1);
    }

    // Changing input file triggers another run. Script succeeds this time.
    {
      await rig.writeAtomic({
        'a.txt': 'v1',
      });
      const inv = await cmdA.nextInvocation();
      inv.exit(0);
      await inv.closed;
    }

    exec.kill();
    await exec.exit;
    assert.equal(cmdA.numInvocations, 2);
  })
);

test(
  'recovers from analysis errors',
  timeout(async ({rig}) => {
    // In this test we do very fast sequences of writes, which causes chokidar
    // to sometimes not report events, possibly caused by some internal
    // throttling it apparently does:
    // https://github.com/paulmillr/chokidar/issues/1084. It seems to affect
    // Linux and Windows but not macOS. Add a short pause to force it to notice
    // the write.
    const pauseToWorkAroundChokidarEventThrottling = () =>
      new Promise((resolve) => setTimeout(resolve, 50));

    // We use `writeAtomic` in this test because it is otherwise possible for
    // chokidar to emit a "change" event before the write has completed,
    // generating JSON syntax errors at unexpected times. The chokidar
    // `awaitWriteFinish` option can address this problem, but it introduces
    // latency because it polls until file size has been stable. Since this only
    // seems to be a problem on CI where the filesystem is slower, we just
    // workaround it in this test using atomic writes. If it happened to a user
    // in practice, either chokidar would emit another event when the write
    // finished and we'd automatically do another run, or the user could save
    // the file again.

    // The minimum to get npm to invoke Wireit at all.
    await rig.writeAtomic('package.json', {
      scripts: {
        a: 'wireit',
      },
    });
    const wireit = rig.exec('npm run a watch');
    await wireit.waitForLog(/no config in the wireit section/);

    // Add a wireit section but without a command.
    await pauseToWorkAroundChokidarEventThrottling();
    await rig.writeAtomic('package.json', {
      scripts: {
        a: 'wireit',
      },
      wireit: {
        a: {},
      },
    });
    await wireit.waitForLog(/nothing for wireit to do/);

    // Add the command.
    const a = await rig.newCommand();
    await pauseToWorkAroundChokidarEventThrottling();
    await rig.writeAtomic('package.json', {
      scripts: {
        a: 'wireit',
      },
      wireit: {
        a: {
          command: a.command,
        },
      },
    });
    (await a.nextInvocation()).exit(0);
    await wireit.waitForLog(/\[a\] Executed successfully/);

    // Add a dependency on another package, but the other package.json has
    // invalid JSON.
    await pauseToWorkAroundChokidarEventThrottling();
    await rig.writeAtomic('other/package.json', 'potato');
    await rig.writeAtomic('package.json', {
      scripts: {
        a: 'wireit',
      },
      wireit: {
        a: {
          command: a.command,
          dependencies: ['./other:b'],
        },
      },
    });
    await wireit.waitForLog(/JSON syntax error/);

    // Make the other package config valid.
    await pauseToWorkAroundChokidarEventThrottling();
    const b = await rig.newCommand();
    await rig.writeAtomic('other/package.json', {
      scripts: {
        b: 'wireit',
      },
      wireit: {
        b: {
          command: b.command,
        },
      },
    });
    (await b.nextInvocation()).exit(0);
    await wireit.waitForLog(/\[other:b\] Executed successfully/);
    (await a.nextInvocation()).exit(0);
    await wireit.waitForLog(/\[a\] Executed successfully/);

    wireit.kill();
    await wireit.exit;
  })
);

test(
  'watchers understand negations',
  timeout(async ({rig}) => {
    const cmdA = await rig.newCommand();
    await rig.writeAtomic({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            files: ['*.txt', '!excluded.txt'],
          },
        },
      },
      'included.txt': 'v0',
      'excluded.txt': 'v0',
    });

    const exec = rig.exec('npm run a watch');

    // Initial run.
    {
      const inv = await cmdA.nextInvocation();
      inv.exit(0);
      assert.equal(cmdA.numInvocations, 1);
    }

    // Changing an excluded file should not trigger a run.
    {
      await rig.writeAtomic({
        'excluded.txt': 'v1',
      });
      // Wait a while to ensure the command doesn't run.
      await new Promise((resolve) => setTimeout(resolve, 100));
      // TODO(aomarks) This would fail if the command runs, but it wouldn't fail
      // if the executor ran. The watcher could be triggering the executor too
      // often, but the executor would be smart enough not to actually execute
      // the command. To confirm that the executor is not running too often, we
      // will need to test for some logged output.
      assert.equal(cmdA.numInvocations, 1);
    }

    // Changing an included file should trigger a run.
    {
      await rig.writeAtomic({
        'included.txt': 'v1',
      });
      const inv = await cmdA.nextInvocation();
      inv.exit(0);
      await inv.closed;
    }

    exec.kill();
    await exec.exit;
    assert.equal(cmdA.numInvocations, 2);
  })
);

test(
  '.dotfiles are watched',
  timeout(async ({rig}) => {
    const cmdA = await rig.newCommand();
    await rig.writeAtomic({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            files: ['*.txt'],
          },
        },
      },
      '.dotfile.txt': 'v0',
    });

    const exec = rig.exec('npm run a watch');

    // Initial run.
    {
      const inv = await cmdA.nextInvocation();
      inv.exit(0);
      assert.equal(cmdA.numInvocations, 1);
    }

    // Changing input file should trigger another run.
    {
      await rig.writeAtomic({
        '.dotfile.txt': 'v1',
      });
      const inv = await cmdA.nextInvocation();
      inv.exit(0);
      await inv.closed;
    }

    exec.kill();
    await exec.exit;
    assert.equal(cmdA.numInvocations, 2);
  })
);

test(
  'package-lock.json files are watched',
  timeout(async ({rig}) => {
    const cmdA = await rig.newCommand();
    await rig.writeAtomic({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            files: [],
          },
        },
      },
      'foo/package-lock.json': 'v0',
      // No parent dir package-lock.json initially.
    });

    const exec = rig.exec('npm run a watch', {cwd: 'foo'});

    // Initial run.
    {
      const inv = await cmdA.nextInvocation();
      inv.exit(0);
      assert.equal(cmdA.numInvocations, 1);
    }

    // Change foo's package-lock.json file. Expect another run.
    {
      await rig.writeAtomic({'foo/package-lock.json': 'v1'});
      const inv = await cmdA.nextInvocation();
      inv.exit(0);
    }

    // Create parent's package-lock.json file. Expect another run.
    {
      await rig.writeAtomic({'package-lock.json': 'v0'});
      const inv = await cmdA.nextInvocation();
      inv.exit(0);
      await inv.closed;
    }

    exec.kill();
    await exec.exit;
    assert.equal(cmdA.numInvocations, 3);
  })
);

test.run();
