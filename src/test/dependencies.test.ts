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
  '<dependencies>#build',
  rigTest(async ({rig}) => {
    const local1 = await rig.newCommand();
    const local2 = await rig.newCommand();
    const local3 = await rig.newCommand();
    const npm1 = await rig.newCommand();
    await rig.write({
      'packages/local1/package.json': {
        name: 'local1',
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            command: local1.command,
            files: [],
            output: [],
            dependencies: ['<dependencies>#build'],
          },
        },
        dependencies: {
          local2: '^1.0.0',
          npm1: '^1.0.0',
        },
        devDependencies: {
          local3: '^1.0.0',
        },
      },
      'packages/local2/package.json': {
        name: 'local2',
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            command: local2.command,
            files: [],
            output: [],
          },
        },
      },
      'packages/local3/package.json': {
        name: 'local3',
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            command: local3.command,
            files: [],
            output: [],
          },
        },
      },
      'node_modules/npm1/package.json': {
        name: 'npm1',
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            command: npm1.command,
            files: [],
            output: [],
          },
        },
      },
    });

    await rig.symlink('../packages/local1', 'node_modules/local1', 'dir');
    await rig.symlink('../packages/local2', 'node_modules/local2', 'dir');
    await rig.symlink('../packages/local3', 'node_modules/local3', 'dir');

    const process = rig.exec('npm run build', {cwd: 'packages/local1'});
    (await local2.nextInvocation()).exit(0);
    (await local3.nextInvocation()).exit(0);
    (await local1.nextInvocation()).exit(0);
    assert.equal((await process.exit).code, 0);
    assert.equal(local1.numInvocations, 1);
    assert.equal(local2.numInvocations, 1);
    assert.equal(local3.numInvocations, 1);
    assert.equal(npm1.numInvocations, 0);
  }),
);

test(
  '<dependencies>#build with no matching scripts',
  rigTest(async ({rig}) => {
    const local1 = await rig.newCommand();
    await rig.write({
      'packages/local1/package.json': {
        name: 'local1',
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            command: local1.command,
            files: [],
            output: [],
            dependencies: ['<dependencies>#build'],
          },
        },
        dependencies: {
          local2: '^1.0.0',
        },
      },
      'packages/local2/package.json': {
        name: 'local2',
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

    await rig.symlink('../packages/local1', 'node_modules/local1', 'dir');
    await rig.symlink('../packages/local2', 'node_modules/local2', 'dir');

    const process = rig.exec('npm run build', {cwd: 'packages/local1'});
    const done = await process.exit;
    assert.equal(done.code, 1);
    assert.equal(local1.numInvocations, 0);
    checkScriptOutput(
      done.stderr,
      `
    ❌ package.json:12:10 No dependencies had a script called "build"
            "<dependencies>#build"
             ~~~~~~~~~~~~~~
    `,
    );
  }),
);

test.run();
