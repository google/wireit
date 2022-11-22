/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {WireitTestRig} from './util/test-rig.js';
import {Analyzer} from '../analyzer.js';

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

test('analyzes services', async ({rig}) => {
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
  assert.equal(a.name, 'a');
  if (a.command) {
    throw new Error('Expected no-command');
  }
  assert.equal(a.dependencies.length, 3);

  // b
  const b = a.dependencies[0].config;
  assert.equal(b.name, 'b');
  if (!b.service) {
    throw new Error('Expected service');
  }
  assert.equal(b.serviceConsumers.length, 1);
  assert.equal(b.serviceConsumers[0].name, 'd');
  assert.equal(b.isPersistent, true);

  // c
  const c = a.dependencies[1].config;
  assert.equal(c.name, 'c');
  if (!c.service) {
    throw new Error('Expected service');
  }
  assert.equal(c.isPersistent, true);
  assert.equal(c.serviceConsumers.length, 0);
  assert.equal(c.services.length, 0);

  // d
  const d = a.dependencies[2].config;
  assert.equal(d.name, 'd');
  assert.equal(d.services.length, 2);
  assert.equal(d.services[0].name, 'b');
  assert.equal(d.services[1].name, 'e');

  // e
  const e = d.services[1];
  assert.equal(e.name, 'e');
  if (!e.service) {
    throw new Error('Expected service');
  }
  assert.equal(e.isPersistent, false);
  assert.equal(e.serviceConsumers.length, 1);
});

test(
  '.wireit/, .git/, and node_modules/ are automatically ' +
    'excluded from input and output files by default',
  async ({rig}) => {
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
      []
    );
    if (!result.config.ok) {
      console.log(result.config.error);
      throw new Error('Not ok');
    }

    const withDefaultExcludes = result.config.value;
    assert.equal(withDefaultExcludes.files?.values, [
      '**/*.ts',
      '!.git/',
      '!.hg/',
      '!.svn/',
      '!.wireit/',
      '!.yarn/',
      '!CVS/',
      '!node_modules/',
    ]);
    assert.equal(withDefaultExcludes.output?.values, [
      '**/*.js',
      '!.git/',
      '!.hg/',
      '!.svn/',
      '!.wireit/',
      '!.yarn/',
      '!CVS/',
      '!node_modules/',
    ]);
  }
);

test(
  'Default excluded paths are not present when ' +
    'allowUsuallyExcludedPaths is true',
  async ({rig}) => {
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
      []
    );
    if (!result.config.ok) {
      console.log(result.config.error);
      throw new Error('Not ok');
    }

    const build = result.config.value;
    assert.equal(build.files?.values, ['**/*.ts']);
    assert.equal(build.output?.values, ['**/*.js']);
  }
);

test('Default excluded paths are not present when files and output are empty', async ({
  rig,
}) => {
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
    []
  );
  if (!result.config.ok) {
    console.log(result.config.error);
    throw new Error('Not ok');
  }

  const build = result.config.value;
  assert.equal(build.files?.values, []);
  assert.equal(build.output?.values, []);
});

test.run();
