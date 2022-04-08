/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import * as pathlib from 'path';
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
  'wireit section is not an object',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: [],
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [a] Invalid config: wireit is not an object`.trim()
    );
  })
);

test(
  'wireit config is not an object',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: [],
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [a] Invalid config: wireit[a] is not an object`.trim()
    );
  })
);

test(
  'dependencies is not an array',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: {},
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [a] Invalid config: dependencies is not an array`.trim()
    );
  })
);

test(
  'dependency is not a string',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: [[]],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [a] Invalid config: dependencies[0] is not a string`.trim()
    );
  })
);

test(
  'command is not a string',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: [],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [a] Invalid config: command is not a string`.trim()
    );
  })
);

test(
  'files is not an array',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            files: {},
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [a] Invalid config: files is not an array`.trim()
    );
  })
);

test(
  'file item is not a string',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            files: [0],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [a] Invalid config: files[0] is not a string`.trim()
    );
  })
);

test(
  'output is not an array',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            output: {},
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [a] Invalid config: output is not an array`.trim()
    );
  })
);

test(
  'output item is not a string',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            output: [0],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [a] Invalid config: output[0] is not a string`.trim()
    );
  })
);

test(
  'clean is not a boolean or "if-file-deleted"',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            clean: 0,
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [a] Invalid config: clean must be true, false, or "if-file-deleted"`.trim()
    );
  })
);

test(
  'packageLocks is not an array',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            packageLocks: 0,
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [a] Invalid config: packageLocks is not an array`.trim()
    );
  })
);

test(
  'packageLocks item is not a string',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            packageLocks: [0],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [a] Invalid config: packageLocks[0] is not a string`.trim()
    );
  })
);

test(
  'packageLocks item is not a filename',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            packageLocks: ['../package-lock.json'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [a] Invalid config: packageLocks[0] must be a filename, not a path`.trim()
    );
  })
);

test(
  'missing dependency',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['missing'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [missing] No script named "missing" was found in ${rig.temp}`.trim()
    );
  })
);

test(
  'duplicate dependency',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'true',
        },
        wireit: {
          a: {
            dependencies: ['b', 'b'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [a] The dependency "b" was declared multiple times`.trim()
    );
  })
);

test(
  'script command is not wireit',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'not-wireit',
        },
        wireit: {
          a: {
            dependencies: ['b'],
          },
          b: {
            command: 'true',
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [b] Script is not configured to call "wireit"
`.trim()
    );
  })
);

test(
  'script is wireit but has no wireit config',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {},
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [a] Invalid config: script has no wireit config`.trim()
    );
  })
);

test(
  'script has no command and no dependencies',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {},
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [a] Invalid config: script has no command and no dependencies`.trim()
    );
  })
);

test(
  "cross-package dependency doesn't have a colon",
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['../foo'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [a] Invalid config: Cross-package dependency must use syntax "<relative-path>:<script-name>", but there was no ":" character in "../foo".
`.trim()
    );
  })
);

test(
  "cross-package dependency doesn't have a script name",
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['../foo:'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [a] Invalid config: Cross-package dependency must use syntax "<relative-path>:<script-name>", but there was no script name in "../foo:".
`.trim()
    );
  })
);

test(
  'cross-package dependency resolves to the same package (".")',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['.:b'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [a] Invalid config: Cross-package dependency ".:b" resolved to the same package.
`.trim()
    );
  })
);

test(
  'cross-package dependency resolves to the same package (up and back)',
  timeout(async ({rig}) => {
    await rig.write({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['../foo:b'],
          },
        },
      },
    });
    const result = rig.exec('npm run a', {cwd: 'foo'});
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [a] Invalid config: Cross-package dependency "../foo:b" resolved to the same package.
`.trim()
    );
  })
);

test(
  'cross-package dependency leads to directory without package.json',
  timeout(async ({rig}) => {
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
    });
    const result = rig.exec('npm run a', {cwd: 'foo'});
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [../bar:b] No package.json was found in ${pathlib.resolve(rig.temp, 'bar')}
`.trim()
    );
  })
);

test(
  'cross-package dependency leads to package.json with invalid JSON',
  timeout(async ({rig}) => {
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
      'bar/package.json': 'THIS IS NOT VALID JSON',
    });
    const result = rig.exec('npm run a', {cwd: 'foo'});
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [../bar:b] Invalid JSON in package.json file in ${pathlib.resolve(
        rig.temp,
        'bar'
      )}
`.trim()
    );
  })
);

test(
  'cycle of length 1',
  timeout(async ({rig}) => {
    //  a
    //  ^ \
    //  |  |
    //  +--+
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['a'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
❌ [a] Cycle detected
.-> a
\`-- a
`.trim()
    );
  })
);

test(
  'cycle of length 2',
  timeout(async ({rig}) => {
    //  a --> b
    //  ^     |
    //  |     |
    //  +-----+
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['b'],
          },
          b: {
            dependencies: ['a'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const {code, stderr} = await result.exit;
    assert.equal(code, 1);
    assert.equal(
      stderr.trim(),
      `
❌ [a] Cycle detected
.-> a
|   b
\`-- a
`.trim()
    );
  })
);

test(
  'cycle of length 3',
  timeout(async ({rig}) => {
    //  a --> b --> c
    //  ^           |
    //  |           |
    //  +-----------+
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
          c: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['b'],
          },
          b: {
            dependencies: ['c'],
          },
          c: {
            dependencies: ['a'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const {code, stderr} = await result.exit;
    assert.equal(code, 1);
    assert.equal(
      stderr.trim(),
      `
❌ [a] Cycle detected
.-> a
|   b
|   c
\`-- a
`.trim()
    );
  })
);

test(
  '2 cycles of length 1',
  timeout(async ({rig}) => {
    //  a -----> b
    //  ^ \     ^ \
    //  | |     | |
    //  +-+     +-+
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['a', 'b'],
          },
          b: {
            dependencies: ['b'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const {code, stderr} = await result.exit;
    assert.equal(code, 1);
    assert.equal(
      stderr.trim(),
      `
❌ [a] Cycle detected
.-> a
\`-- a
    `.trim()
    );
  })
);

test(
  'cycle with lead up and lead out',
  timeout(async ({rig}) => {
    //  a --> b --> c --> d --> e
    //        ^           |
    //        |           |
    //        +-----------+
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
            dependencies: ['b'],
          },
          b: {
            dependencies: ['c'],
          },
          c: {
            dependencies: ['d'],
          },
          d: {
            dependencies: ['e', 'b'],
          },
          e: {
            command: 'true',
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const {code, stderr} = await result.exit;
    assert.equal(code, 1);
    assert.equal(
      stderr.trim(),
      `
❌ [b] Cycle detected
    a
.-> b
|   c
|   d
\`-- b
`.trim()
    );
  })
);

test(
  'cycle with multiple trails',
  timeout(async ({rig}) => {
    //    +------+
    //   /        \
    //  /          v
    // a --> b --> c --> d
    //       ^          /
    //        \        /
    //         +------+
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
            dependencies: ['b', 'c'],
          },
          b: {
            dependencies: ['c'],
          },
          c: {
            dependencies: ['d'],
          },
          d: {
            dependencies: ['b'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
  ❌ [b] Cycle detected
    a
.-> b
|   c
|   d
\`-- b
      `.trim()
    );
  })
);

test(
  'cycle with multiple trails (with different dependency order)',
  timeout(async ({rig}) => {
    //    +------+
    //   /        \
    //  /          v
    // a --> b --> c --> d
    //       ^          /
    //        \        /
    //         +------+
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
            // The order declared shouldn't affect the path we take to detect
            // the cycle.
            dependencies: ['c', 'b'],
          },
          b: {
            dependencies: ['c'],
          },
          c: {
            dependencies: ['d'],
          },
          d: {
            dependencies: ['b'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assert.equal(
      done.stderr.trim(),
      `
  ❌ [b] Cycle detected
    a
.-> b
|   c
|   d
\`-- b
      `.trim()
    );
  })
);

test(
  'cycle across packages',
  timeout(async ({rig}) => {
    //  foo:a --> bar:b
    //    ^         |
    //    |         |
    //    +---------+
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
            dependencies: ['../foo:a'],
          },
        },
      },
    });
    const result = rig.exec('npm run a', {cwd: 'foo'});
    const {code, stderr} = await result.exit;
    assert.equal(code, 1);
    assert.equal(
      stderr.trim(),
      `
❌ [a] Cycle detected
.-> a
|   ../bar:b
\`-- a
`.trim()
    );
  })
);

test.run();
