/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {timeout} from './util/uvu-timeout.js';
import {WireitTestRig} from './util/test-rig.js';

const test = suite<{rig: WireitTestRig}>();

test.before.each(async (ctx) => {
  ctx.rig = new WireitTestRig();
  await ctx.rig.setup();
});

test.after.each(async (ctx) => {
  await ctx.rig.cleanup();
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

// TODO(aomarks) Test.skip missing-package-json and invalid-package-json errors, but
// we can't do that until we support cross-package dependencies, since if either
// of those problems affected the entrypoint package, then "npm run" would fail
// before wireit even got a chance to start.

test.run();
