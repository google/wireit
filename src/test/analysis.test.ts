/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {rigTest} from './util/rig-test.js';
import {Analyzer} from '../analyzer.js';
import {parseDependency} from '../analysis/dependency-parser.js';

const test = suite<object>();

test(
  'analyzes services',
  rigTest(async ({rig}) => {
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
    const result = await analyzer.analyze(
      {packageDir: rig.temp, name: 'a'},
      [],
    );
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
    const b = a.dependencies[0]!.config;
    assert.equal(b.name, 'b');
    if (!b.service) {
      throw new Error('Expected service');
    }
    assert.equal(b.serviceConsumers.length, 1);
    assert.equal(b.serviceConsumers[0]!.name, 'd');
    assert.equal(b.isPersistent, true);

    // c
    const c = a.dependencies[1]!.config;
    assert.equal(c.name, 'c');
    if (!c.service) {
      throw new Error('Expected service');
    }
    assert.equal(c.isPersistent, true);
    assert.equal(c.serviceConsumers.length, 0);
    assert.equal(c.services.length, 0);

    // d
    const d = a.dependencies[2]!.config;
    assert.equal(d.name, 'd');
    assert.equal(d.services.length, 2);
    assert.equal(d.services[0]!.name, 'b');
    assert.equal(d.services[1]!.name, 'e');

    // e
    const e = d.services[1]!;
    assert.equal(e.name, 'e');
    if (!e.service) {
      throw new Error('Expected service');
    }
    assert.equal(e.isPersistent, false);
    assert.equal(e.serviceConsumers.length, 1);
  }),
);

test(
  '.wireit/, .git/, and node_modules/ are automatically ' +
    'excluded from input and output files by default',
  rigTest(async ({rig}) => {
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
  }),
);

test(
  'Default excluded paths are not present when ' +
    'allowUsuallyExcludedPaths is true',
  rigTest(async ({rig}) => {
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
    assert.equal(build.files?.values, ['**/*.ts']);
    assert.equal(build.output?.values, ['**/*.js']);
  }),
);

test(
  'Default excluded paths are not present when files and output are empty',
  rigTest(async ({rig}) => {
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
    assert.equal(build.files?.values, []);
    assert.equal(build.output?.values, []);
  }),
);

test(
  'dependencies are found',
  rigTest(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
          c: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            dependencies: ['b', 'c'],
          },
          b: {
            command: 'true',
            dependencies: ['c'],
          },
          c: {
            command: 'true',
          },
        },
      },
    });

    const analyzer = new Analyzer('npm');
    const result = await analyzer.analyze(
      {
        packageDir: rig.temp,
        name: 'a',
      },
      [],
    );
    if (!result.config.ok) {
      console.log(result.config.error);
      throw new Error('Not ok');
    }

    const build = result.config.value;
    assert.equal(build.dependencies?.length, 2);
    const [b, c] = build.dependencies;
    assert.equal(b?.config.name, 'b');
    assert.equal(c?.config.name, 'c');
  }),
);

test(
  'dependency scripts are found',
  rigTest(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
          c: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            dependencies: ['b', 'c'],
          },
          b: {
            command: 'true',
            dependencies: ['c'],
          },
          c: {
            command: 'true',
          },
        },
      },
    });

    const analyzer = new Analyzer('npm');
    const result = await analyzer.analyze(
      {
        packageDir: rig.temp,
        name: 'a',
      },
      [],
    );
    if (!result.config.ok) {
      console.log(result.config.error);
      throw new Error('Not ok');
    }

    const build = result.config.value;
    assert.equal(build.dependencies?.length, 2);
    const [b, c] = build.dependencies;
    assert.equal(b?.config.name, 'b');
    assert.equal(c?.config.name, 'c');
  }),
);

test(
  'dependency script name globs are expanded',
  rigTest(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          main: 'wireit',
          foo1: 'wireit',
          foo2: 'wireit',
          bar1: 'wireit',
        },
        wireit: {
          main: {
            command: 'true',
            dependencies: ['foo*'],
          },
          foo1: {command: 'true'},
          foo2: {command: 'true'},
          bar1: {command: 'true'},
        },
      },
    });

    const analyzer = new Analyzer('npm');
    const result = await analyzer.analyze(
      {
        packageDir: rig.temp,
        name: 'main',
      },
      [],
    );
    if (!result.config.ok) {
      console.log(result.config.error);
      throw new Error('Not ok');
    }

    const build = result.config.value;
    assert.equal(build.dependencies?.length, 2);
    const [foo1, foo2] = build.dependencies;
    assert.equal(foo1?.config.name, 'foo1');
    assert.equal(foo2?.config.name, 'foo2');
  }),
);

const cases = [
  [
    './foo:bar:baz',
    {
      package: [{kind: 'literal', value: './foo'}],
      script: [{kind: 'literal', value: 'bar:baz'}],
    },
  ],
  [
    './foo/*:bar*',
    {
      package: [{kind: 'literal', value: './foo/*'}],
      script: [{kind: 'literal', value: 'bar*'}],
    },
  ],
  [
    'bar',
    {
      package: [],
      script: [{kind: 'literal', value: 'bar'}],
    },
  ],
  [
    ':bar',
    {
      package: [],
      script: [{kind: 'literal', value: ':bar'}],
    },
  ],
  [
    './foo\\:bar:baz',
    {
      package: [{kind: 'literal', value: './foo\\'}],
      script: [{kind: 'literal', value: 'bar:baz'}],
    },
  ],
  [
    './foo\\:bar:baz:qux',
    {
      package: [{kind: 'literal', value: './foo\\'}],
      script: [{kind: 'literal', value: 'bar:baz:qux'}],
    },
  ],
  ['./foo', {package: [{kind: 'literal', value: './foo'}], script: []}],
  ['./foo/bar', {package: [{kind: 'literal', value: './foo/bar'}], script: []}],
  [
    './foo\\/bar',
    {package: [{kind: 'literal', value: './foo\\/bar'}], script: []},
  ],
  ['', {package: [], script: []}],
  [':', {package: [], script: [{kind: 'literal', value: ':'}]}],
  [
    '../foo:bar',
    {
      package: [{kind: 'literal', value: '../foo'}],
      script: [{kind: 'literal', value: 'bar'}],
    },
  ],
  ['...', {package: [{kind: 'literal', value: '...'}], script: []}],
  [
    '...:...',
    {
      package: [{kind: 'literal', value: '...'}],
      script: [{kind: 'literal', value: '...'}],
    },
  ],
  [
    './packages/*:<this>',
    {
      package: [{kind: 'literal', value: './packages/*'}],
      script: [{kind: 'variable', value: 'this'}],
    },
  ],
  [
    './packages/*:foo<this>bar',
    {
      package: [{kind: 'literal', value: './packages/*'}],
      script: [
        {kind: 'literal', value: 'foo'},
        {kind: 'variable', value: 'this'},
        {kind: 'literal', value: 'bar'},
      ],
    },
  ],
  [
    './packages/*:\\<this>',
    {
      package: [{kind: 'literal', value: './packages/*'}],
      script: [{kind: 'literal', value: '<this>'}],
    },
  ],

  [
    './packages/*:<this',
    {
      package: [{kind: 'literal', value: './packages/*'}],
      // TODO(aomarks) Better representation.
      script: [{kind: 'variable', value: 'ERROR'}],
    },
  ],

  [
    './<workspaces>/:<this>',
    {
      package: [
        {kind: 'literal', value: './'},
        {kind: 'variable', value: 'workspaces'},
        {kind: 'literal', value: '/'},
      ],
      script: [{kind: 'variable', value: 'this'}],
    },
  ],

  [
    './\\<workspaces>/:<this>',
    {
      package: [{kind: 'literal', value: './<workspaces>/'}],
      script: [{kind: 'variable', value: 'this'}],
    },
  ],

  [
    './packages/foo:bar',
    {
      package: [{kind: 'literal', value: './packages/foo'}],
      script: [{kind: 'literal', value: 'bar'}],
    },
  ],

  [
    '\\./packages/foo:bar',
    {
      package: [],
      // TODO(aomarks) Are you sure about this?
      script: [{kind: 'literal', value: '\\./packages/foo:bar'}],
    },
  ],

  [
    './packages/foo:./packages/foo',
    {
      package: [{kind: 'literal', value: './packages/foo'}],
      script: [{kind: 'literal', value: './packages/foo'}],
    },
  ],

  [
    '<workspaces>:<this>',
    {
      package: [],
      script: [
        {kind: 'variable', value: 'workspaces'},
        {kind: 'literal', value: ':'},
        {kind: 'variable', value: 'this'},
      ],
    },
  ],

  [
    '<workspaces>#<this>',
    {
      package: [{kind: 'variable', value: 'workspaces'}],
      script: [{kind: 'variable', value: 'this'}],
    },
  ],
  [
    'a<workspaces>b#c<this>d',
    {
      package: [
        {kind: 'literal', value: 'a'},
        {kind: 'variable', value: 'workspaces'},
        {kind: 'literal', value: 'b'},
      ],
      script: [
        {kind: 'literal', value: 'c'},
        {kind: 'variable', value: 'this'},
        {kind: 'literal', value: 'd'},
      ],
    },
  ],

  [
    '<this>',
    {
      package: [],
      script: [{kind: 'variable', value: 'this'}],
    },
  ],

  [
    '<this><workspaces>',
    {
      package: [],
      script: [
        {kind: 'variable', value: 'this'},
        {kind: 'variable', value: 'workspaces'},
      ],
    },
  ],

  [
    'build:tsc',
    {
      package: [],
      script: [{kind: 'literal', value: 'build:tsc'}],
    },
  ],

  [
    '\\<workspaces>:\\<this>',
    {
      package: [],
      script: [{kind: 'literal', value: '<workspaces>:<this>'}],
    },
  ],
] as const;

for (const [dependency, expected] of cases) {
  test.only(dependency, () => {
    assert.equal(parseDependency(dependency), {ok: true, value: expected});
  });
}

test.run();
