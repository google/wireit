/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {checkScriptOutput} from './util/check-script-output.js';
import {rigTest} from './util/rig-test.js';

const test = suite<object>();

test(
  '<workspaces>:build',
  rigTest(async ({rig}) => {
    const foo = await rig.newCommand();
    const bar = await rig.newCommand();
    const baz = await rig.newCommand();
    await rig.write({
      'package.json': {
        workspaces: ['packages/*'],
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            dependencies: ['<workspaces>:build'],
          },
        },
      },
      'packages/foo/package.json': {
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            command: foo.command,
            files: [],
            output: [],
          },
        },
      },
      'packages/bar/package.json': {
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            command: bar.command,
            files: [],
            output: [],
          },
        },
      },
      'packages/baz/package.json': {
        scripts: {
          test: 'wireit',
        },
        wireit: {
          // "baz" doesn't have a "build" script, so it's ignored.
          test: {
            command: baz.command,
            files: [],
            output: [],
          },
        },
      },
    });

    const process = rig.exec('npm run build');
    const nextFoo = foo.nextInvocation();
    const nextBar = bar.nextInvocation();
    const result = await Promise.race([nextFoo, nextBar, process.exit]);
    if ('code' in result) {
      throw new Error(`Unexpected exit: ${result.code}`);
    }
    (await nextFoo).exit(0);
    (await nextBar).exit(0);
    assert.equal((await process.exit).code, 0);
    assert.equal(foo.numInvocations, 1);
    assert.equal(bar.numInvocations, 1);
    assert.equal(baz.numInvocations, 0);
  }),
);

test(
  'nested <workspaces>:build',
  rigTest(async ({rig}) => {
    const foo = await rig.newCommand();
    const bar = await rig.newCommand();
    const baz = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            dependencies: ['./nested:build'],
          },
        },
      },
      'nested/package.json': {
        workspaces: ['packages/*'],
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            dependencies: ['<workspaces>:build'],
          },
        },
      },
      'nested/packages/foo/package.json': {
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            command: foo.command,
            files: [],
            output: [],
          },
        },
      },
      'nested/packages/bar/package.json': {
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            command: bar.command,
            files: [],
            output: [],
          },
        },
      },
      'nested/packages/baz/package.json': {
        scripts: {
          test: 'wireit',
        },
        wireit: {
          test: {
            command: baz.command,
            files: [],
            output: [],
          },
        },
      },
    });

    const process = rig.exec('npm run build');
    const nextFoo = foo.nextInvocation();
    const nextBar = bar.nextInvocation();
    const result = await Promise.race([nextFoo, nextBar, process.exit]);
    if ('code' in result) {
      throw new Error(`Unexpected exit: ${result.code}`);
    }
    (await nextFoo).exit(0);
    (await nextBar).exit(0);
    assert.equal((await process.exit).code, 0);
    assert.equal(foo.numInvocations, 1);
    assert.equal(bar.numInvocations, 1);
    assert.equal(baz.numInvocations, 0);
  }),
);

test(
  '<workspaces>:<this>',
  rigTest(async ({rig}) => {
    const foo = await rig.newCommand();
    const bar = await rig.newCommand();
    const baz = await rig.newCommand();
    await rig.write({
      'package.json': {
        workspaces: ['packages/*'],
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            dependencies: ['<workspaces>:<this>'],
          },
        },
      },
      'packages/foo/package.json': {
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            command: foo.command,
            files: [],
            output: [],
          },
        },
      },
      'packages/bar/package.json': {
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            command: bar.command,
            files: [],
            output: [],
          },
        },
      },
      'packages/baz/package.json': {
        scripts: {
          test: 'wireit',
        },
        wireit: {
          test: {
            command: baz.command,
            files: [],
            output: [],
          },
        },
      },
    });

    const process = rig.exec('npm run build');
    const nextFoo = foo.nextInvocation();
    const nextBar = bar.nextInvocation();
    const result = await Promise.race([nextFoo, nextBar, process.exit]);
    if ('code' in result) {
      throw new Error(`Unexpected exit: ${result.code}`);
    }
    (await nextFoo).exit(0);
    (await nextBar).exit(0);
    assert.equal((await process.exit).code, 0);
    assert.equal(foo.numInvocations, 1);
    assert.equal(bar.numInvocations, 1);
    assert.equal(baz.numInvocations, 0);
  }),
);

test(
  '<workspaces>:build with workspace !exclusions',
  rigTest(async ({rig}) => {
    const foo = await rig.newCommand();
    const bar = await rig.newCommand();
    const baz = await rig.newCommand();
    await rig.write({
      'package.json': {
        workspaces: [
          // Remove "foo"; no-op since no positive match yet.
          '!packages/foo',
          // Add all packages.
          'packages/*',
          // Exclude "bar" and "baz"
          '!packages/bar',
          '!packages/baz',
          // Add back" bar".
          'packages/bar',
          // ... so we expect "foo" and "bar" to run, but not "baz".
        ],
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            dependencies: ['<workspaces>:build'],
          },
        },
      },
      'packages/foo/package.json': {
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            command: foo.command,
            files: [],
            output: [],
          },
        },
      },
      'packages/bar/package.json': {
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            command: bar.command,
            files: [],
            output: [],
          },
        },
      },
      'packages/baz/package.json': {
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            command: baz.command,
            files: [],
            output: [],
          },
        },
      },
    });

    const process = rig.exec('npm run build');
    const nextFoo = foo.nextInvocation();
    const nextBar = bar.nextInvocation();

    const maybeEarlyExit = await Promise.race([
      process.exit,
      Promise.all([nextFoo, nextBar]),
    ]);
    if ('code' in maybeEarlyExit) {
      throw new Error(`Unexpected exit: ${maybeEarlyExit.code}`);
    }

    (await nextFoo).exit(0);
    (await nextBar).exit(0);

    // Fail quickly if baz starts to run (otherwise we time-out).
    await new Promise((resolve) => setTimeout(resolve, 50));
    void baz.nextInvocation().then(() => {
      throw new Error('Unexpected invocation of baz');
    });

    assert.equal((await process.exit).code, 0);
    assert.equal(foo.numInvocations, 1);
    assert.equal(bar.numInvocations, 1);
    assert.equal(baz.numInvocations, 0);
  }),
);

test(
  '<workspaces>#build with script !exclusions',
  rigTest(async ({rig}) => {
    const foo = await rig.newCommand();
    const bar = await rig.newCommand();
    const baz = await rig.newCommand();
    await rig.write({
      'package.json': {
        workspaces: ['packages/*'],
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            dependencies: [
              // Remove "foo"; no-op since no positive match yet.
              '!./packages/foo#build',
              // Add all packages.
              '<workspaces>#build',
              // Exclude "bar" and "baz"
              '!./packages/bar#build',
              '!./packages/baz#build',
              // Add back" bar".
              './packages/bar#build',
              // ... so we expect "foo" and "bar" to run, but not "baz".
            ],
          },
        },
      },
      'packages/foo/package.json': {
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            command: foo.command,
            files: [],
            output: [],
          },
        },
      },
      'packages/bar/package.json': {
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            command: bar.command,
            files: [],
            output: [],
          },
        },
      },
      'packages/baz/package.json': {
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            command: baz.command,
            files: [],
            output: [],
          },
        },
      },
    });

    const process = rig.exec('npm run build');
    const nextFoo = foo.nextInvocation();
    const nextBar = bar.nextInvocation();

    const maybeEarlyExit = await Promise.race([
      process.exit,
      Promise.all([nextFoo, nextBar]),
    ]);
    if ('code' in maybeEarlyExit) {
      throw new Error(`Unexpected exit: ${maybeEarlyExit.code}`);
    }

    (await nextFoo).exit(0);
    (await nextBar).exit(0);

    // Fail quickly if baz starts to run (otherwise we time-out).
    await new Promise((resolve) => setTimeout(resolve, 50));
    void baz.nextInvocation().then(() => {
      throw new Error('Unexpected invocation of baz');
    });

    assert.equal((await process.exit).code, 0);
    assert.equal(foo.numInvocations, 1);
    assert.equal(bar.numInvocations, 1);
    assert.equal(baz.numInvocations, 0);
  }),
);

test(
  '<workspaces>:build --watch',
  rigTest(async ({rig}) => {
    const foo = await rig.newCommand();
    const bar = await rig.newCommand();
    const baz = await rig.newCommand();
    await rig.write({
      'package.json': {
        workspaces: ['packages/*'],
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            dependencies: ['<workspaces>:build'],
          },
        },
      },
      'packages/foo/package.json': {
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            command: foo.command,
            files: [],
            output: [],
          },
        },
      },
    });

    // Initially only the "foo" workspace exists.
    const process = rig.exec('npm run build --watch');
    (await foo.nextInvocation()).exit(0);

    // Create a new "bar" workspace.
    await rig.write({
      'packages/bar/package.json': {
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            command: bar.command,
            files: [],
            output: [],
          },
        },
      },
    });
    (await bar.nextInvocation()).exit(0);

    // Create a new "baz" workspace, but it doesn't have a "build" script.
    await rig.write({
      'packages/baz/package.json': {
        scripts: {
          test: 'wireit',
        },
        wireit: {
          test: {
            command: baz.command,
            files: [],
            output: [],
          },
        },
      },
    });
    // Give some time to make sure nothing happens.
    await new Promise((resolve) => setTimeout(resolve, 50));

    process.kill();
    assert.equal((await process.exit).code, 0);
    assert.equal(foo.numInvocations, 1);
    assert.equal(bar.numInvocations, 1);
    assert.equal(baz.numInvocations, 0);
  }),
);

test(
  '<workspaces>:build --watch with work workspace !exclusions',
  rigTest(async ({rig}) => {
    const foo = await rig.newCommand();
    const bar = await rig.newCommand();
    const baz = await rig.newCommand();
    await rig.write({
      'package.json': {
        workspaces: [
          // Remove "foo"; no-op since no positive match yet.
          '!packages/foo',
          // Add all packages.
          'packages/*',
          // Exclude "bar" and "baz"
          '!packages/bar',
          '!packages/baz',
          // Add back" bar".
          'packages/bar',
          // ... so we expect "foo" and "bar" to run, but not "baz".
        ],
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            dependencies: ['<workspaces>:build'],
          },
        },
      },
      'packages/foo/package.json': {
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            command: foo.command,
            files: [],
            output: [],
          },
        },
      },
    });

    // Initially only the "foo" workspace exists.
    const process = rig.exec('npm run build --watch');
    (await foo.nextInvocation()).exit(0);

    // Create a new "bar" workspace.
    await rig.write({
      'packages/bar/package.json': {
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            command: bar.command,
            files: [],
            output: [],
          },
        },
      },
    });
    (await bar.nextInvocation()).exit(0);

    // Create a new "baz" workspace, but it's inverted so it doesn't run.
    await rig.write({
      'packages/baz/package.json': {
        scripts: {
          test: 'wireit',
        },
        wireit: {
          test: {
            command: baz.command,
            files: [],
            output: [],
          },
        },
      },
    });
    // Give some time to make sure nothing happens.
    await new Promise((resolve) => setTimeout(resolve, 50));

    process.kill();
    assert.equal((await process.exit).code, 0);
    assert.equal(foo.numInvocations, 1);
    assert.equal(bar.numInvocations, 1);
    assert.equal(baz.numInvocations, 0);
  }),
);

test(
  'nested <workspaces>:build --watch',
  rigTest(async ({rig}) => {
    const foo = await rig.newCommand();
    const bar = await rig.newCommand();
    const baz = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            dependencies: ['./nested:build'],
          },
        },
      },
      'nested/package.json': {
        workspaces: ['packages/*'],
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            dependencies: ['<workspaces>:build'],
          },
        },
      },
      'nested/packages/foo/package.json': {
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            command: foo.command,
            files: [],
            output: [],
          },
        },
      },
    });

    // Initially only the "foo" workspace exists.
    const process = rig.exec('npm run build --watch');
    (await foo.nextInvocation()).exit(0);

    // Create a new "bar" workspace.
    await rig.write({
      'nested/packages/bar/package.json': {
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            command: bar.command,
            files: [],
            output: [],
          },
        },
      },
    });
    (await bar.nextInvocation()).exit(0);

    // Create a new "baz" workspace, but it doesn't have a "build" script.
    await rig.write({
      'nested/packages/baz/package.json': {
        scripts: {
          test: 'wireit',
        },
        wireit: {
          test: {
            command: baz.command,
            files: [],
            output: [],
          },
        },
      },
    });
    // Give some time to make sure nothing happens.
    await new Promise((resolve) => setTimeout(resolve, 50));

    process.kill();
    assert.equal((await process.exit).code, 0);
    assert.equal(foo.numInvocations, 1);
    assert.equal(bar.numInvocations, 1);
    assert.equal(baz.numInvocations, 0);
  }),
);

test(
  'error: <workspaces> with no workspaces section',
  rigTest(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            dependencies: ['<workspaces>:build'],
          },
        },
      },
    });
    const process = rig.exec('npm run build');
    const done = await process.exit;
    assert.equal(done.code, 1);
    checkScriptOutput(
      done.stderr,
      `
    ❌ package.json:8:10 No workspaces found in package.json
            "<workspaces>:build"
             ~~~~~~~~~~~~
    `,
    );
  }),
);

test(
  'error: <workspaces> with empty workspaces section',
  rigTest(async ({rig}) => {
    await rig.write({
      'package.json': {
        workspaces: [],
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            dependencies: ['<workspaces>:build'],
          },
        },
      },
    });
    const process = rig.exec('npm run build');
    const done = await process.exit;
    assert.equal(done.code, 1);
    checkScriptOutput(
      done.stderr,
      `
    ❌ package.json:9:10 No workspaces found in package.json
            "<workspaces>:build"
             ~~~~~~~~~~~~
    `,
    );
  }),
);

test(
  'error: <workspaces> with no matching scripts',
  rigTest(async ({rig}) => {
    await rig.write({
      'package.json': {
        workspaces: ['packages/*'],
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            dependencies: ['<workspaces>:build'],
          },
        },
      },
      'packages/foo/package.json': {
        scripts: {
          test: 'wireit',
        },
        wireit: {
          test: {
            command: 'true',
            files: [],
            output: [],
          },
        },
      },
    });
    const process = rig.exec('npm run build');
    const done = await process.exit;
    assert.equal(done.code, 1);
    checkScriptOutput(
      done.stderr,
      `
    ❌ package.json:11:10 No workspaces had a script called "build"
            "<workspaces>:build"
             ~~~~~~~~~~~~
    `,
    );
  }),
);

test.run();
