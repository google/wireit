/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {test} from 'node:test';
import * as assert from 'node:assert';
import {WireitTestRig} from './util/test-rig.js';
import {Analyzer} from '../analyzer.js';

test('analyzes services', async () => {
  await using rig = await WireitTestRig.setup();
  //    a
  //  / | \
  // |  v  v
  // |  c  d
  // |    / |
  // b <-+  |
  //        v
  //        e
  await rig.write({
    'package.json': {
      scripts: {
        a: 'wireit',
        b: 'wireit',
        c: 'wireit',
        d: 'wireit',
        e: 'wireit',
      },
      wireit: {
        a: {
          dependencies: ['b', 'c', 'd'],
        },
        b: {
          command: 'true',
          service: true,
        },
        c: {
          command: 'true',
          service: true,
        },
        d: {
          command: 'true',
          dependencies: ['b', 'e'],
        },
        e: {
          command: 'true',
          service: true,
        },
      },
    },
  });

  const analyzer = new Analyzer('npm');
  const result = await analyzer.analyze({packageDir: rig.temp, name: 'a'}, []);
  if (!result.config.ok) {
    console.log(result.config.error);
    throw new Error('Not ok');
  }

  // a
  const a = result.config.value;
  assert.strictEqual(a.name, 'a');
  if (a.command) {
    throw new Error('Expected no-command');
  }
  assert.strictEqual(a.dependencies.length, 3);

  // b
  const b = a.dependencies[0]!.config;
  assert.strictEqual(b.name, 'b');
  if (!b.service) {
    throw new Error('Expected service');
  }
  assert.strictEqual(b.serviceConsumers.length, 1);
  assert.strictEqual(b.serviceConsumers[0]!.name, 'd');
  assert.strictEqual(b.isPersistent, true);

  // c
  const c = a.dependencies[1]!.config;
  assert.strictEqual(c.name, 'c');
  if (!c.service) {
    throw new Error('Expected service');
  }
  assert.strictEqual(c.isPersistent, true);
  assert.strictEqual(c.serviceConsumers.length, 0);
  assert.strictEqual(c.services.length, 0);

  // d
  const d = a.dependencies[2]!.config;
  assert.strictEqual(d.name, 'd');
  assert.strictEqual(d.services.length, 2);
  assert.strictEqual(d.services[0]!.name, 'b');
  assert.strictEqual(d.services[1]!.name, 'e');

  // e
  const e = d.services[1]!;
  assert.strictEqual(e.name, 'e');
  if (!e.service) {
    throw new Error('Expected service');
  }
  assert.strictEqual(e.isPersistent, false);
  assert.strictEqual(e.serviceConsumers.length, 1);
});

test(
  '.wireit/, .git/, and node_modules/ are automatically ' +
    'excluded from input and output files by default',
  async () => {
    await using rig = await WireitTestRig.setup();
    await rig.write({
      'package.json': {
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            command: 'true',
            files: ['**/*.ts'],
            output: ['**/*.js'],
            // Don't also automatically add package-lock.json paths as input
            // files, to make this test simpler/more focused.
            packageLocks: [],
          },
        },
      },
    });

    const analyzer = new Analyzer('npm');
    const result = await analyzer.analyze(
      {
        packageDir: rig.temp,
        name: 'build',
      },
      [],
    );
    if (!result.config.ok) {
      console.log(result.config.error);
      throw new Error('Not ok');
    }

    const withDefaultExcludes = result.config.value;
    assert.deepStrictEqual(withDefaultExcludes.files?.values, [
      '**/*.ts',
      '!.git/',
      '!.hg/',
      '!.svn/',
      '!.wireit/',
      '!.yarn/',
      '!CVS/',
      '!node_modules/',
    ]);
    assert.deepStrictEqual(withDefaultExcludes.output?.values, [
      '**/*.js',
      '!.git/',
      '!.hg/',
      '!.svn/',
      '!.wireit/',
      '!.yarn/',
      '!CVS/',
      '!node_modules/',
    ]);
  },
);

test(
  'Default excluded paths are not present when ' +
    'allowUsuallyExcludedPaths is true',
  async () => {
    await using rig = await WireitTestRig.setup();
    await rig.write({
      'package.json': {
        scripts: {
          build: 'wireit',
        },
        wireit: {
          build: {
            command: 'true',
            files: ['**/*.ts'],
            output: ['**/*.js'],
            // Don't also automatically add package-lock.json paths as input
            // files, to make this test simpler/more focused.
            packageLocks: [],
            allowUsuallyExcludedPaths: true,
          },
        },
      },
    });

    const analyzer = new Analyzer('npm');
    const result = await analyzer.analyze(
      {
        packageDir: rig.temp,
        name: 'build',
      },
      [],
    );
    if (!result.config.ok) {
      console.log(result.config.error);
      throw new Error('Not ok');
    }

    const build = result.config.value;
    assert.deepStrictEqual(build.files?.values, ['**/*.ts']);
    assert.deepStrictEqual(build.output?.values, ['**/*.js']);
  },
);

test('Default excluded paths are not present when files and output are empty', async () => {
  await using rig = await WireitTestRig.setup();
  await rig.write({
    'package.json': {
      scripts: {
        build: 'wireit',
      },
      wireit: {
        build: {
          command: 'true',
          files: [],
          output: [],
          packageLocks: [],
        },
      },
    },
  });

  const analyzer = new Analyzer('npm');
  const result = await analyzer.analyze(
    {
      packageDir: rig.temp,
      name: 'build',
    },
    [],
  );
  if (!result.config.ok) {
    console.log(result.config.error);
    throw new Error('Not ok');
  }

  const build = result.config.value;
  assert.deepStrictEqual(build.files?.values, []);
  assert.deepStrictEqual(build.output?.values, []);
});
