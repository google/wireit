/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import * as assert from 'uvu/assert';
import {suite} from 'uvu';
import {timeout} from './util/uvu-timeout.js';
import {WireitTestRig} from './util/test-rig.js';
import {Options} from '../cli-options.js';
import {Result} from '../error.js';

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

const TEST_BINARY_COMMAND = `node ${pathlib.join(
  process.cwd(),
  'lib',
  'test',
  'util',
  'cli-options-test-binary.js'
)}`;

async function getOptionsResult(
  rig: WireitTestRig,
  command: string,
  env?: Record<string, string | undefined>
): Promise<Result<Options>> {
  await rig.write({
    'package.json': {
      scripts: {
        main: TEST_BINARY_COMMAND,
        test: TEST_BINARY_COMMAND,
        start: TEST_BINARY_COMMAND,
      },
    },
  });
  assert.equal((await rig.exec(command, {env}).exit).code, 0);
  return JSON.parse(await rig.read('options.json')) as Result<Options>;
}

async function assertOptions(
  rig: WireitTestRig,
  command: string,
  expected: Partial<Options> & Pick<Options, 'script'>,
  env?: Record<string, string | undefined>
) {
  const result = await getOptionsResult(rig, command, env);
  assert.equal(result, {
    ok: true,
    value: {
      extraArgs: [],
      watch: false,
      cache: 'local',
      numWorkers: 10,
      failureMode: 'no-new',
      ...expected,
    },
  });
}
for (const agent of ['npm', 'yarn', 'pnpm']) {
  test(
    `${agent} run main`,
    timeout(async ({rig}) => {
      await assertOptions(rig, `${agent} run main`, {
        script: {
          packageDir: rig.temp,
          name: 'main',
        },
      });
    })
  );

  test(
    `${agent} test`,
    timeout(async ({rig}) => {
      await assertOptions(rig, `${agent} test`, {
        script: {
          packageDir: rig.temp,
          name: 'test',
        },
      });
    })
  );

  test(
    `${agent} start`,
    timeout(async ({rig}) => {
      await assertOptions(rig, `${agent} start`, {
        script: {
          packageDir: rig.temp,
          name: 'start',
        },
      });
    })
  );

  test(
    `${agent} run main -- --extra`,
    timeout(async ({rig}) => {
      await assertOptions(rig, `${agent} run main -- --extra`, {
        script: {
          packageDir: rig.temp,
          name: 'main',
        },
        extraArgs: ['--extra'],
      });
    })
  );

  // Does not work in pnpm, see https://github.com/pnpm/pnpm/issues/4821.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  (agent === 'pnpm' ? test.skip : test)(
    `${agent} test -- --extra`,
    timeout(async ({rig}) => {
      await assertOptions(rig, `${agent} test -- --extra`, {
        script: {
          packageDir: rig.temp,
          name: 'test',
        },
        extraArgs: ['--extra'],
      });
    })
  );

  test(
    `${agent} start -- --extra`,
    timeout(async ({rig}) => {
      await assertOptions(rig, `${agent} start -- --extra`, {
        script: {
          packageDir: rig.temp,
          name: 'start',
        },
        extraArgs: ['--extra'],
      });
    })
  );

  test(
    `${agent} run main --watch`,
    timeout(async ({rig}) => {
      await assertOptions(rig, `${agent} run main --watch`, {
        script: {
          packageDir: rig.temp,
          name: 'main',
        },
        watch: true,
      });
    })
  );

  // Does not work in pnpm, see https://github.com/pnpm/pnpm/issues/4821.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  (agent === 'pnpm' ? test.skip : test)(
    `${agent} test --watch`,
    timeout(async ({rig}) => {
      await assertOptions(rig, `${agent} test --watch`, {
        script: {
          packageDir: rig.temp,
          name: 'test',
        },
        watch: true,
      });
    })
  );

  test(
    `${agent} start --watch`,
    timeout(async ({rig}) => {
      await assertOptions(rig, `${agent} start --watch`, {
        script: {
          packageDir: rig.temp,
          name: 'start',
        },
        watch: true,
      });
    })
  );

  test(
    `${agent} run main --watch -- --extra`,
    timeout(async ({rig}) => {
      await assertOptions(rig, `${agent} run main --watch -- --extra`, {
        script: {
          packageDir: rig.temp,
          name: 'main',
        },
        extraArgs: ['--extra'],
        watch: true,
      });
    })
  );

  // Does not work in pnpm, see https://github.com/pnpm/pnpm/issues/4821.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  (agent === 'pnpm' ? test.skip : test)(
    `${agent} test --watch -- --extra`,
    timeout(async ({rig}) => {
      await assertOptions(rig, `${agent} test --watch -- --extra`, {
        script: {
          packageDir: rig.temp,
          name: 'test',
        },
        extraArgs: ['--extra'],
        watch: true,
      });
    })
  );

  test(
    `${agent} start --watch -- --extra`,
    timeout(async ({rig}) => {
      await assertOptions(rig, `${agent} start --watch -- --extra`, {
        script: {
          packageDir: rig.temp,
          name: 'start',
        },
        extraArgs: ['--extra'],
        watch: true,
      });
    })
  );
}

test.run();
