/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {dedent} from 'ts-dedent';
import {rigTest} from './util/rig-test.js';
import {IS_WINDOWS} from '../util/windows.js';
import {injectYarnBerryToRig} from './util/yarn-berry.js';
import {NODE_MAJOR_VERSION} from './util/node-version.js';
import {checkScriptOutput} from './util/check-script-output.js';

const test = suite<object>();

test(
  'rig commands exit and emit stdout/stderr as requested',
  rigTest(async ({rig}) => {
    // Test 2 different simultaneous commands, one with two simultaneous
    // invocations.
    const cmdA = await rig.newCommand();
    const cmdB = await rig.newCommand();

    const execA1 = rig.exec(cmdA.command);
    const invA1 = await cmdA.nextInvocation();
    const execA2 = rig.exec(cmdA.command);
    const invA2 = await cmdA.nextInvocation();
    const execB1 = rig.exec(cmdB.command);
    const invB1 = await cmdB.nextInvocation();

    invA1.stdout('a1 stdout');
    invA1.stderr('a1 stderr');
    invA2.stdout('a2 stdout');
    invA2.stderr('a2 stderr');
    invB1.stdout('b1 stdout');
    invB1.stderr('b1 stderr');

    invA1.exit(42);
    invA2.exit(43);
    invB1.exit(44);

    const resA1 = await execA1.exit;
    const resA2 = await execA2.exit;
    const resB1 = await execB1.exit;

    assert.match(resA1.stdout, 'a1 stdout');
    assert.match(resA1.stderr, 'a1 stderr');
    assert.match(resA2.stdout, 'a2 stdout');
    assert.match(resA2.stderr, 'a2 stderr');
    assert.match(resB1.stdout, 'b1 stdout');
    assert.match(resB1.stderr, 'b1 stderr');

    assert.equal(resA1.code, 42);
    assert.equal(resA2.code, 43);
    assert.equal(resB1.code, 44);
  }),
);

test(
  'runs one script that succeeds',
  rigTest(async ({rig}) => {
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
    await exec.waitForLog(/0% \[0 \/ 1\] \[1 running\] a/);

    const invA = await cmdA.nextInvocation();
    invA.stdout('a stdout\n');
    // immediately logged, because it's the root command
    await exec.waitForLog(/a stdout/);
    invA.stderr('a stderr\n');
    await exec.waitForLog(/a stderr/);
    invA.exit(0);

    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
    checkScriptOutput(res.stderr, 'a stderr\n');
    assert.match(res.stdout, 'a stdout\n');
    assert.match(res.stdout, '✅ Ran 1 script and skipped 0 in');
    assert.equal(
      res.debugLog?.trim(),
      `
<info> analysis-started
<info> analysis-completed
<info> running
🏃 [a] Running command "${cmdA.command}"
<success> exit-zero
✅ [a] Executed successfully`.trim(),
    );
  }),
);

test(
  'runs one script that succeeds from a package sub-directory',
  rigTest(async ({rig}) => {
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
      // This file is here just to create "subdir".
      'subdir/foo.txt': '',
    });

    // Just like normal npm, when we run "npm run" from a directory that doesn't
    // have a package.json, we should find the nearest package.json up the
    // filesystem hierarchy.
    const exec = rig.exec('npm run a', {cwd: 'subdir'});
    await exec.waitForLog(/0% \[0 \/ 1\] \[1 running\] a/);

    const invA = await cmdA.nextInvocation();
    invA.stdout('a stdout\n');
    // immediately logged, because it's the root command
    await exec.waitForLog(/a stdout/);
    invA.stderr('a stderr\n');
    await exec.waitForLog(/a stderr/);
    invA.exit(0);

    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
    checkScriptOutput(res.stderr, 'a stderr\n');
    assert.match(res.stdout, 'a stdout\n');
    assert.match(res.stdout, '✅ Ran 1 script and skipped 0 in');
  }),
);

test(
  'dependency chain in one package that succeeds',
  rigTest(async ({rig}) => {
    // a --> b --> c
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
    await exec.waitForLog(/0% \[0 \/ 3\] \[1 running\] c/);

    const invC = await cmdC.nextInvocation();
    invC.stdout('c stdout');
    invC.stderr('c stderr');
    invC.exit(0);
    await exec.waitForLog(/33% \[1 \/ 3\] \[1 running\] b/);

    const invB = await cmdB.nextInvocation();
    invB.stdout('b stdout');
    invB.stderr('b stderr');
    invB.exit(0);
    await exec.waitForLog(/67% \[2 \/ 3\] \[1 running\] a/);

    const invA = await cmdA.nextInvocation();
    invA.stdout('a stdout\n');
    // immediately logged, because it's the root command
    await exec.waitForLog(/a stdout/);
    invA.stderr('a stderr\n');
    await exec.waitForLog(/a stderr/);
    invA.exit(0);

    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
    assert.equal(cmdB.numInvocations, 1);
    assert.equal(cmdC.numInvocations, 1);
    assert.match(res.stdout, 'a stdout\n');
    assert.match(res.stdout, /Ran 3 scripts and skipped 0/s);
    // we only see the output of the root command
    checkScriptOutput(res.stderr, 'a stderr\n');
  }),
);

test(
  'dependency chain with vanilla npm script at the end',
  rigTest(async ({rig}) => {
    // a --> b --> c
    const cmdA = await rig.newCommand();
    const cmdB = await rig.newCommand();
    const cmdC = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
          // wireit scripts can depend on non-wireit scripts.
          c: cmdC.command,
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
        },
      },
    });
    const exec = rig.exec('npm run a');
    await exec.waitForLog(/0% \[0 \/ 3\] \[1 running\] c/);

    const invC = await cmdC.nextInvocation();
    invC.stdout('c stdout');
    invC.stderr('c stderr');
    invC.exit(0);
    await exec.waitForLog(/33% \[1 \/ 3\] \[1 running\] b/);

    const invB = await cmdB.nextInvocation();
    invB.stdout('b stdout');
    invB.stderr('b stderr');
    invB.exit(0);
    await exec.waitForLog(/67% \[2 \/ 3\] \[1 running\] a/);

    const invA = await cmdA.nextInvocation();
    invA.stdout('a stdout\n');
    // immediately logged, because it's the root command
    await exec.waitForLog(/a stdout/);
    invA.stderr('a stderr\n');
    await exec.waitForLog(/a stderr/);
    invA.exit(0);

    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
    assert.equal(cmdB.numInvocations, 1);
    assert.equal(cmdC.numInvocations, 1);
    assert.match(res.stdout, 'a stdout\n');
    assert.match(res.stdout, /Ran 3 scripts and skipped 0/s);
    // we only see the output of the root command
    checkScriptOutput(res.stderr, 'a stderr\n');
  }),
);

test(
  'dependency diamond in one package that succeeds',
  rigTest(async ({rig}) => {
    //     a
    //    / \
    //   v   v
    //   b   c
    //    \ /
    //     v
    //     d
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
            dependencies: ['b', 'c'],
          },
          b: {
            command: cmdB.command,
            dependencies: ['d'],
          },
          c: {
            command: cmdC.command,
            dependencies: ['d'],
          },
          d: {
            command: cmdD.command,
          },
        },
      },
    });
    const exec = rig.exec('npm run a');
    await exec.waitForLog(/0% \[0 \/ 4\] \[1 running\] d/);

    const invD = await cmdD.nextInvocation();
    invD.exit(0);
    await exec.waitForLog(/25% \[1 \/ 4\] \[2 running\] (b|c)/);

    const invB = await cmdB.nextInvocation();
    const invC = await cmdC.nextInvocation();
    invB.exit(0);
    await exec.waitForLog(/50% \[2 \/ 4\] \[1 running\] c/);
    invC.exit(0);
    await exec.waitForLog(/75% \[3 \/ 4\] \[1 running\] a/);

    const invA = await cmdA.nextInvocation();
    invA.exit(0);

    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
    assert.equal(cmdB.numInvocations, 1);
    assert.equal(cmdC.numInvocations, 1);
    assert.equal(cmdD.numInvocations, 1);
    assert.match(res.stdout, /Ran 4 scripts and skipped 0/s);
  }),
);

test(
  'cross-package dependency',
  rigTest(async ({rig}) => {
    const cmdA = await rig.newCommand();
    const cmdB = await rig.newCommand();
    await rig.write({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            dependencies: ['../bar:b'],
          },
        },
      },
      'bar/package.json': {
        scripts: {
          b: 'wireit',
        },
        wireit: {
          b: {
            command: cmdB.command,
          },
        },
      },
    });
    const exec = rig.exec('npm run a', {cwd: 'foo'});
    await exec.waitForLog(/0% \[0 \/ 2\] \[1 running\] \.\.\/bar:b/);

    const invB = await cmdB.nextInvocation();
    invB.exit(0);
    await exec.waitForLog(/50% \[1 \/ 2\] \[1 running\] a/);

    const invA = await cmdA.nextInvocation();
    invA.exit(0);

    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
    assert.equal(cmdB.numInvocations, 1);
    assert.match(res.stdout, /Ran 2 scripts and skipped 0/s);
  }),
);

test(
  'cross-package dependency using object format',
  rigTest(async ({rig}) => {
    const cmdA = await rig.newCommand();
    const cmdB = await rig.newCommand();
    await rig.write({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            dependencies: [
              {
                script: '../bar:b',
              },
            ],
          },
        },
      },
      'bar/package.json': {
        scripts: {
          b: 'wireit',
        },
        wireit: {
          b: {
            command: cmdB.command,
          },
        },
      },
    });
    const exec = rig.exec('npm run a', {cwd: 'foo'});
    await exec.waitForLog(/0% \[0 \/ 2\] \[1 running\] \.\.\/bar:b/);

    const invB = await cmdB.nextInvocation();
    invB.exit(0);
    await exec.waitForLog(/50% \[1 \/ 2\] \[1 running\] a/);

    const invA = await cmdA.nextInvocation();
    invA.exit(0);

    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
    assert.equal(cmdB.numInvocations, 1);
    assert.match(res.stdout, /Ran 2 scripts and skipped 0/s);
  }),
);

test(
  'cross-package dependency that validly cycles back to the first package',
  rigTest(async ({rig}) => {
    // Cycles between packages are fine, as long as there aren't cycles in the
    // script graph.
    const cmdA = await rig.newCommand();
    const cmdB = await rig.newCommand();
    const cmdC = await rig.newCommand();
    await rig.write({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
          c: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            dependencies: ['../bar:b'],
          },
          c: {
            command: cmdC.command,
          },
        },
      },
      'bar/package.json': {
        scripts: {
          b: 'wireit',
        },
        wireit: {
          b: {
            command: cmdB.command,
            dependencies: ['../foo:c'],
          },
        },
      },
    });
    const exec = rig.exec('npm run a', {cwd: 'foo'});
    await exec.waitForLog(/0% \[0 \/ 3\] \[1 running\] c/);

    const invC = await cmdC.nextInvocation();
    invC.exit(0);
    await exec.waitForLog(/33% \[1 \/ 3\] \[1 running\] \.\.\/bar:b/);

    const invB = await cmdB.nextInvocation();
    invB.exit(0);
    await exec.waitForLog(/67% \[2 \/ 3\] \[1 running\] a/);

    const invA = await cmdA.nextInvocation();
    invA.exit(0);

    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
    assert.equal(cmdB.numInvocations, 1);
    assert.equal(cmdC.numInvocations, 1);
    assert.match(res.stdout, /Ran 3 scripts and skipped 0/s);
  }),
);

test(
  'finds node_modules binary in starting dir',
  rigTest(async ({rig}) => {
    const cmd = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'test-binary',
          },
        },
      },
    });
    await rig.generateAndInstallNodeBinary({
      command: cmd.command,
      binaryPath: 'node_modules/test-pkg/test-binary',
      installPath: 'node_modules/.bin/test-binary',
    });
    const exec = rig.exec('npm run a');
    (await cmd.nextInvocation()).exit(0);
    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmd.numInvocations, 1);
  }),
);

test(
  'finds node_modules binary in parent dir',
  rigTest(async ({rig}) => {
    const cmd = await rig.newCommand();
    await rig.write({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'test-binary',
          },
        },
      },
    });
    await rig.generateAndInstallNodeBinary({
      command: cmd.command,
      binaryPath: 'node_modules/test-pkg/test-binary',
      installPath: 'node_modules/.bin/test-binary',
    });
    const exec = rig.exec('npm run a', {cwd: 'foo'});
    (await cmd.nextInvocation()).exit(0);
    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmd.numInvocations, 1);
  }),
);

test(
  'finds node_modules binary across packages (child)',
  rigTest(async ({rig}) => {
    const cmd = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['./bar:b'],
          },
        },
      },
      'bar/package.json': {
        scripts: {
          b: 'wireit',
        },
        wireit: {
          b: {
            command: 'test-binary',
          },
        },
      },
    });
    await rig.generateAndInstallNodeBinary({
      command: cmd.command,
      binaryPath: 'bar/node_modules/test-pkg/test-binary',
      installPath: 'bar/node_modules/.bin/test-binary',
    });
    const exec = rig.exec('npm run a');
    (await cmd.nextInvocation()).exit(0);
    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmd.numInvocations, 1);
  }),
);

test(
  'finds node_modules binary across packages (sibling)',
  rigTest(async ({rig}) => {
    const cmd = await rig.newCommand();
    await rig.write({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['../bar:b'],
          },
        },
      },
      'bar/package.json': {
        scripts: {
          b: 'wireit',
        },
        wireit: {
          b: {
            command: 'test-binary',
          },
        },
      },
    });
    await rig.generateAndInstallNodeBinary({
      command: cmd.command,
      binaryPath: 'bar/node_modules/test-pkg/test-binary',
      installPath: 'bar/node_modules/.bin/test-binary',
    });
    const exec = rig.exec('npm run a', {cwd: 'foo'});
    (await cmd.nextInvocation()).exit(0);
    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmd.numInvocations, 1);
  }),
);

test(
  'starting node_modules binaries are not available across packages (sibling)',
  rigTest(async ({rig}) => {
    const cmd = await rig.newCommand();
    await rig.write({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['../bar:b'],
          },
        },
      },
      'bar/package.json': {
        scripts: {
          b: 'wireit',
        },
        wireit: {
          b: {
            command: 'test-binary',
          },
        },
      },
    });
    await rig.generateAndInstallNodeBinary({
      command: cmd.command,
      binaryPath: 'foo/node_modules/test-pkg/test-binary',
      installPath: 'foo/node_modules/.bin/test-binary',
    });
    const exec = rig.exec('npm run b', {cwd: 'bar'});
    const res = await exec.exit;
    assert.equal(res.code, 1);
    assert.equal(cmd.numInvocations, 0);
    assert.match(
      res.stderr,
      IS_WINDOWS
        ? "'test-binary' is not recognized"
        : 'exited with exit code 127',
    );
  }),
);

// Node workspaces are only supported in npm 7+, which shipped with Node v15.
// eslint-disable-next-line @typescript-eslint/unbound-method
(NODE_MAJOR_VERSION > 14 ? test : test.skip)(
  'commands run under npm workspaces',
  rigTest(async ({rig}) => {
    const cmdA = await rig.newCommand();
    const cmdB = await rig.newCommand();
    await rig.write({
      'package.json': {
        workspaces: ['foo', 'bar'],
      },
      'foo/package.json': {
        scripts: {
          cmd: 'wireit',
        },
        wireit: {
          cmd: {
            command: cmdA.command,
          },
        },
      },
      'bar/package.json': {
        scripts: {
          cmd: 'wireit',
        },
        wireit: {
          cmd: {
            command: cmdB.command,
          },
        },
      },
    });

    // Run both from the workspaces root package.
    {
      const exec = rig.exec('npm run cmd -ws');
      // Workspace commands run in serial.
      (await cmdA.nextInvocation()).exit(0);
      (await cmdB.nextInvocation()).exit(0);
      assert.equal((await exec.exit).code, 0);
      assert.equal(cmdA.numInvocations, 1);
      assert.equal(cmdB.numInvocations, 1);
    }

    // Run one from the workspace package.
    {
      const exec = rig.exec('npm run cmd', {cwd: 'foo'});
      (await cmdA.nextInvocation()).exit(0);
      assert.equal((await exec.exit).code, 0);
      assert.equal(cmdA.numInvocations, 2);
      assert.equal(cmdB.numInvocations, 1);
    }
  }),
);

test(
  'finds package directory without npm_package_json',
  rigTest(async ({rig}) => {
    // This confirms that we can walk up the filesystem to find the nearest
    // package.json when the npm_package_json environment variable isn't set.
    // This variable isn't set by yarn, pnpm, and older versions of npm.
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
    await rig.mkdir('foo/bar/baz');
    const exec = rig.exec(
      IS_WINDOWS
        ? '..\\..\\..\\node_modules\\.bin\\wireit.cmd'
        : '../../../node_modules/.bin/wireit',
      {
        cwd: 'foo/bar/baz',
        env: {
          npm_lifecycle_event: 'a',
        },
      },
    );
    (await cmdA.nextInvocation()).exit(0);
    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
  }),
);

test(
  'runs a script with yarn',
  rigTest(async ({rig}) => {
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
    const exec = rig.exec('yarn run a');
    await exec.waitForLog(/0% \[0 \/ 1\] \[1 running\] a/);
    (await cmdA.nextInvocation()).exit(0);
    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
    assert.match(res.stdout, /Ran 1 script and skipped 0/s);
  }),
);

test(
  'runs a script with pnpm',
  rigTest(async ({rig}) => {
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
    const exec = rig.exec('pnpm run a');
    await exec.waitForLog(/0% \[0 \/ 1\] \[1 running\] a/);
    (await cmdA.nextInvocation()).exit(0);
    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
    assert.match(res.stdout, /Ran 1 script and skipped 0/s);
  }),
);

test(
  'commands run under yarn workspaces',
  rigTest(async ({rig}) => {
    const cmdA = await rig.newCommand();
    const cmdB = await rig.newCommand();
    await rig.write({
      'package.json': {
        // Yarn workspaces only work when the root is private.
        private: true,
        // Yarn is particular about packages having names and versions.
        name: 'root',
        version: '1.0.0',
        workspaces: ['foo', 'bar'],
      },
      'foo/package.json': {
        name: 'foo',
        version: '1.0.0',
        scripts: {
          cmd: 'wireit',
        },
        wireit: {
          cmd: {
            command: cmdA.command,
          },
        },
      },
      'bar/package.json': {
        name: 'bar',
        version: '1.0.0',
        scripts: {
          cmd: 'wireit',
        },
        wireit: {
          cmd: {
            command: cmdB.command,
          },
        },
      },
    });

    // Run both from the workspaces root package.
    {
      const exec = rig.exec('yarn workspaces run cmd');
      // Workspace commands run in serial.
      (await cmdA.nextInvocation()).exit(0);
      (await cmdB.nextInvocation()).exit(0);
      assert.equal((await exec.exit).code, 0);
      assert.equal(cmdA.numInvocations, 1);
      assert.equal(cmdB.numInvocations, 1);
    }

    // Run one from the workspace package.
    {
      const exec = rig.exec('yarn run cmd', {cwd: 'foo'});
      (await cmdA.nextInvocation()).exit(0);
      assert.equal((await exec.exit).code, 0);
      assert.equal(cmdA.numInvocations, 2);
      assert.equal(cmdB.numInvocations, 1);
    }
  }),
);

test(
  'commands can be run locally in yarn berry',
  rigTest(async ({rig}) => {
    await injectYarnBerryToRig(rig);

    const rootCmd = await rig.newCommand();
    const innerCmd = await rig.newCommand();

    const originalLock = await rig.read('yarn.lock');

    await rig.write({
      'package.json': {
        private: true,
        workspaces: ['packages/*'],
        scripts: {
          cmd: 'yarn run -B wireit',
        },
        wireit: {
          cmd: {
            command: rootCmd.command,
          },
        },
        devDependencies: {
          wireit: '*',
        },
        resolutions: {
          wireit: `portal:${process.cwd()}`,
        },
      },

      'packages/inner/package.json': {
        scripts: {
          cmd: 'yarn run -TB wireit',
        },
        wireit: {
          cmd: {
            command: innerCmd.command,
          },
        },
      },

      // On a real system, `yarn` should do this automatically; however, in this
      // test rig, a stale copy (`originalLock`) remains, even if we manually
      // run `yarn`.  Therefore, we manually update the lockfile here to include
      // the inner package.
      'yarn.lock':
        originalLock +
        dedent`

        "inner-d81e84@workspace:packages/inner":
          version: 0.0.0-use.local
          resolution: "inner-d81e84@workspace:packages/inner"
          languageName: unknown
          linkType: soft

        "wireit@portal:${process.cwd()}::locator=root-workspace-0b6124%40workspace%3A.":
          version: 0.0.0-use.local
          resolution: "wireit@portal:${process.cwd()}::locator=root-workspace-0b6124%40workspace%3A."
          dependencies:
            braces: "npm:^3.0.2"
            chokidar: "npm:^3.5.3"
            dedent: "npm:^1.5.1"
            fast-glob: "npm:^3.2.11"
            jsonc-parser: "npm:^3.0.0"
            proper-lockfile: "npm:^4.1.2"
            ts-dedent: "npm:^2.2.0"
          bin:
            wireit: bin/wireit.js
          languageName: node
          linkType: soft
      `,
    });

    // this is what should modify the lockfile, so we don't have to do it
    // manually
    rig.exec('yarn');

    // logging: can be deleted once this works
    //
    // since the `.bin` is already set up by the test rig, IDK if we should need to
    // modify the lockfile to include wireit.  however, it's saying
    //
    //     Usage Error: Couldn't find a script name "wireit" in the top-level (used by inner-d81e84@workspace:packages/inner).
    //
    // so i'm trying to make it work
    rig.exec('ls -la node_modules/.bin');
    rig.read('yarn.lock').then(console.log);

    {
      const exec = rig.exec('yarn run cmd', {cwd: 'packages/inner'});
      (
        await Promise.race([
          innerCmd.nextInvocation(),
          rootCmd.nextInvocation(),
        ])
      ).exit(0);
      assert.equal((await exec.exit).code, 0);
      assert.equal(innerCmd.numInvocations, 1);
      assert.equal(rootCmd.numInvocations, 0);
    }
  }),
);

test(
  'commands run under pnpm workspaces',
  rigTest(async ({rig}) => {
    const cmdA = await rig.newCommand();
    const cmdB = await rig.newCommand();
    await rig.write({
      'pnpm-workspace.yaml': `
        packages:
          - foo
          - bar
      `,
      'foo/package.json': {
        scripts: {
          cmd: 'wireit',
        },
        wireit: {
          cmd: {
            command: cmdA.command,
          },
        },
      },
      'bar/package.json': {
        scripts: {
          cmd: 'wireit',
        },
        wireit: {
          cmd: {
            command: cmdB.command,
          },
        },
      },
    });

    // Run both from the workspaces root package.
    {
      const exec = rig.exec('pnpm run --recursive cmd');
      // Workspace commands run in serial.
      (await cmdA.nextInvocation()).exit(0);
      (await cmdB.nextInvocation()).exit(0);
      assert.equal((await exec.exit).code, 0);
      assert.equal(cmdA.numInvocations, 1);
      assert.equal(cmdB.numInvocations, 1);
    }

    // Run one from the workspace package.
    {
      const exec = rig.exec('pnpm run cmd', {cwd: 'foo'});
      (await cmdA.nextInvocation()).exit(0);
      assert.equal((await exec.exit).code, 0);
      assert.equal(cmdA.numInvocations, 2);
      assert.equal(cmdB.numInvocations, 1);
    }
  }),
);

test(
  'multiple cross-package dependencies',
  rigTest(async ({rig}) => {
    const cmdA = await rig.newCommand();
    const cmdB = await rig.newCommand();
    const cmdC = await rig.newCommand();
    await rig.write({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            dependencies: ['../bar:b', '../baz:c'],
          },
        },
      },
      'bar/package.json': {
        scripts: {
          b: 'wireit',
        },
        wireit: {
          b: {
            command: cmdB.command,
          },
        },
      },
      'baz/package.json': {
        scripts: {
          c: 'wireit',
        },
        wireit: {
          c: {
            command: cmdC.command,
          },
        },
      },
    });

    const exec = rig.exec('npm run a', {cwd: 'foo'});
    await exec.waitForLog(
      /0% \[0 \/ 3\] \[2 running\] (\.\.\/bar:b|\.\.\/baz:c)/,
    );

    const invC = await cmdC.nextInvocation();
    invC.exit(0);
    await exec.waitForLog(/33% \[1 \/ 3\] \[1 running\] \.\.\/bar:b/);

    const invB = await cmdB.nextInvocation();
    invB.exit(0);
    await exec.waitForLog(/67% \[2 \/ 3\] \[1 running\] a/);

    const invA = await cmdA.nextInvocation();
    invA.exit(0);

    const res = await exec.exit;
    assert.equal(res.code, 0);
    assert.equal(cmdA.numInvocations, 1);
    assert.equal(cmdB.numInvocations, 1);
    assert.equal(cmdC.numInvocations, 1);
    assert.match(res.stdout, /Ran 3 scripts and skipped 0/s);
  }),
);

test(
  'top-level SIGINT kills running scripts',
  rigTest(async ({rig}) => {
    const main = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          main: 'wireit',
        },
        wireit: {
          main: {
            command: main.command,
          },
        },
      },
    });

    const wireit = rig.exec('npm run main');
    const inv = await main.nextInvocation();
    wireit.kill();
    await inv.closed;
    await wireit.exit;
    assert.equal(main.numInvocations, 1);
    // on windows we just die without reporting anything when we get a SIGINT
    if (!IS_WINDOWS) {
      await wireit.waitForLog(/❌ \[main\] killed/);
      await wireit.waitForLog(/❌ 1 script failed/);
    }
  }),
);

for (const agent of ['npm', 'yarn', 'pnpm']) {
  test(
    `can pass extra args with using "${agent} run --"`,
    rigTest(async ({rig}) => {
      const cmdA = await rig.newCommand();
      await rig.write({
        'package.json': {
          scripts: {
            a: 'wireit',
          },
          wireit: {
            a: {
              command: cmdA.command,
              // Explicit empty input and output files so that we can be fresh.
              files: [],
              output: [],
            },
          },
        },
      });

      // Initially stale.
      {
        const wireit = rig.exec(`${agent} run a -- foo -bar --baz`);
        const inv = await cmdA.nextInvocation();
        assert.equal((await inv.environment()).argv.slice(3), [
          'foo',
          '-bar',
          '--baz',
        ]);
        inv.exit(0);
        assert.equal((await wireit.exit).code, 0);
        await wireit.waitForLog(/Ran 1 script and skipped 0/s); //
      }

      // Nothing changed, fresh.
      {
        const wireit = rig.exec(`${agent} run a -- foo -bar --baz`);
        assert.equal((await wireit.exit).code, 0);
        await wireit.waitForLog(/Ran 0 scripts and skipped 1/s); //
      }

      // Changing the extra args should change the fingerprint so that we're
      // stale.
      {
        const wireit = rig.exec(`${agent} run a -- FOO -BAR --BAZ`);
        const inv = await cmdA.nextInvocation();
        assert.equal((await inv.environment()).argv.slice(3), [
          'FOO',
          '-BAR',
          '--BAZ',
        ]);
        inv.exit(0);
        assert.equal((await wireit.exit).code, 0);
        await wireit.waitForLog(/Ran 1 script and skipped 0/s); //
      }
    }),
  );
}

test(
  'cascade:false dependency does not inherit fingerprint',
  rigTest(async ({rig}) => {
    //  a --[cascade:false]--> b --> c
    const a = await rig.newCommand();
    const b = await rig.newCommand();
    const c = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
          c: 'wireit',
        },
        wireit: {
          a: {
            command: a.command,
            dependencies: [
              {
                script: 'b',
                cascade: false,
              },
            ],
            files: ['inputs/a'],
            output: [],
          },
          b: {
            command: b.command,
            dependencies: ['c'],
            files: ['inputs/b'],
            output: [],
          },
          c: {
            command: c.command,
            files: ['inputs/c'],
            output: [],
          },
        },
      },
    });

    // Initially everything runs.
    {
      await rig.write('inputs/a', 'v1');
      await rig.write('inputs/b', 'v1');
      await rig.write('inputs/c', 'v1');
      const wireit = rig.exec('npm run a');
      await wireit.waitForLog(/0% \[0 \/ 3\] \[1 running\] c/);
      (await c.nextInvocation()).exit(0);
      await wireit.waitForLog(/33% \[1 \/ 3\] \[1 running\] b/);
      (await b.nextInvocation()).exit(0);
      await wireit.waitForLog(/67% \[2 \/ 3\] \[1 running\] a/);
      (await a.nextInvocation()).exit(0);
      assert.equal((await wireit.exit).code, 0);
      assert.equal(a.numInvocations, 1);
      assert.equal(b.numInvocations, 1);
      assert.equal(c.numInvocations, 1);
      await wireit.waitForLog(/Ran 3 scripts and skipped 0/);
    }

    // Changing input of B re-runs B but not A.
    {
      await rig.write('inputs/b', 'v2');
      const wireit = rig.exec('npm run a');
      await wireit.waitForLog(/33% \[1 \/ 3\] \[1 running\] b/);
      (await b.nextInvocation()).exit(0);
      assert.equal((await wireit.exit).code, 0);
      assert.equal(a.numInvocations, 1);
      assert.equal(b.numInvocations, 2);
      assert.equal(c.numInvocations, 1);
      await wireit.waitForLog(/Ran 1 script and skipped 2/);
    }

    // Changing input of C re-runs B and C but not A.
    {
      await rig.write('inputs/c', 'v2');
      const wireit = rig.exec('npm run a');
      await wireit.waitForLog(/0% \[0 \/ 3\] \[1 running\] c/);
      (await c.nextInvocation()).exit(0);
      await wireit.waitForLog(/33% \[1 \/ 3\] \[1 running\] b/);
      (await b.nextInvocation()).exit(0);
      assert.equal((await wireit.exit).code, 0);
      assert.equal(a.numInvocations, 1);
      assert.equal(b.numInvocations, 3);
      assert.equal(c.numInvocations, 2);
      await wireit.waitForLog(/Ran 2 scripts and skipped 1/);
    }

    // Changing input of A re-runs A (just to be sure!).
    {
      await rig.write('inputs/a', 'v2');
      const wireit = rig.exec('npm run a');
      (await a.nextInvocation()).exit(0);
      assert.equal((await wireit.exit).code, 0);
      assert.equal(a.numInvocations, 2);
      assert.equal(b.numInvocations, 3);
      assert.equal(c.numInvocations, 2);
    }
  }),
);

test(
  'can write fingerprint file for extremely large script graph',
  rigTest(async ({rig}) => {
    // These numbers found experimentally, they were just enough to trigger an
    // "Invalid string length" error from JSON.stringify while trying to write
    // the fingerprint file.
    const numScripts = 20;
    const numInputFilesPerScript = 5;

    const packageJson: {
      scripts: Record<string, string>;
      wireit: Record<
        string,
        {
          command: string;
          files: string[];
          output: string[];
          dependencies: string[];
        }
      >;
    } = {
      scripts: {},
      wireit: {},
    };
    const files: Record<string, string | object> = {
      'package.json': packageJson,
    };
    for (let s = 0; s < numScripts; s++) {
      packageJson.scripts[s] = 'wireit';
      packageJson.wireit[s] = {
        command: 'true',
        files: [`inputs/${s}/*`],
        output: [],
        dependencies: [],
      };
      for (let f = 0; f < numInputFilesPerScript; f++) {
        files[`inputs/${s}/${f}`] = '';
      }
      // Add an explicit dependency on all subsequent scripts. This causes the
      // fingerprint size to grow much faster than only including the next
      // script.
      for (let d = s + 1; d < numScripts; d++) {
        packageJson.wireit[s]!.dependencies.push(`${d}`);
      }
    }
    await rig.write(files);

    const wireit = rig.exec('npm run 0');
    assert.equal((await wireit.exit).code, 0);
  }),
);

test(
  'environment variables are passed to children',
  rigTest(async ({rig}) => {
    const cmdA = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            files: [],
            output: [],
            env: {
              FOO: 'foo-good',
              BAR: {
                external: true,
              },
            },
          },
        },
      },
    });

    const wireit = rig.exec('npm run a', {
      env: {
        // Overridden in the script config
        FOO: 'foo-bad',
        // Other vars should be passed down, regardless of "external" (which
        // only affects fingerprinting).
        BAR: 'bar-good',
        BAZ: 'baz-good',
      },
    });
    const inv = await cmdA.nextInvocation();
    const {env} = await inv.environment();
    assert.equal(env.FOO, 'foo-good');
    assert.equal(env.BAR, 'bar-good');
    assert.equal(env.BAZ, 'baz-good');
    inv.exit(0);
    assert.equal((await wireit.exit).code, 0);
  }),
);

test(
  'dependency which is not in script section',
  rigTest(async ({rig}) => {
    const cmdA = await rig.newCommand();
    const cmdB = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            files: [],
            output: [],
            dependencies: ['b'],
          },
          b: {
            command: cmdB.command,
            files: [],
            output: [],
          },
        },
      },
    });

    const wireit = rig.exec('npm run a');
    await wireit.waitForLog(/0% \[0 \/ 2\] \[1 running\] b/);
    (await cmdB.nextInvocation()).exit(0);
    await wireit.waitForLog(/50% \[1 \/ 2\] \[1 running\] a/);
    (await cmdA.nextInvocation()).exit(0);
    const {code} = await wireit.exit;
    assert.equal(code, 0);
    await wireit.waitForLog(/Ran 2 scripts and skipped 0/);
  }),
);

test.run();
