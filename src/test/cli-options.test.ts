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
  'cli-options-test-binary.js',
)}`;

async function getOptionsResult(
  rig: WireitTestRig,
  command: string,
  env?: Record<string, string | undefined>,
  extraScripts?: Record<string, string>,
): Promise<Result<Options>> {
  await rig.write({
    'package.json': {
      scripts: {
        main: TEST_BINARY_COMMAND,
        test: TEST_BINARY_COMMAND,
        start: TEST_BINARY_COMMAND,
        ...extraScripts,
      },
    },
  });
  assert.equal((await rig.exec(command, {env}).exit).code, 0);
  return JSON.parse(await rig.read('options.json')) as Result<Options>;
}

async function assertOptions(
  rig: WireitTestRig,
  command: string,
  expected: Omit<Partial<Options>, 'logger'> &
    Pick<Options, 'script'> & {logger?: string},
  env?: Record<string, string | undefined>,
  extraScripts?: Record<string, string>,
) {
  const result = await getOptionsResult(rig, command, env, extraScripts);
  assert.equal(result, {
    ok: true,
    value: {
      extraArgs: [],
      watch: false,
      cache: 'local',
      numWorkers: 10,
      failureMode: 'no-new',
      logger: 'QuietLogger',
      ...expected,
    },
  });
}

for (const command of ['npm', 'yarn', 'pnpm'] as const) {
  const agent = command === 'yarn' ? 'yarnClassic' : command;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const skipIfYarn = command === 'yarn' ? test.skip : test;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const skipIfPnpm = command === 'pnpm' ? test.skip : test;

  test(
    `${command} run main`,
    timeout(async ({rig}) => {
      await assertOptions(rig, `${command} run main`, {
        agent,
        script: {
          packageDir: rig.temp,
          name: 'main',
        },
      });
    }),
  );

  test(
    `${command} test`,
    timeout(async ({rig}) => {
      await assertOptions(rig, `${command} test`, {
        agent,
        script: {
          packageDir: rig.temp,
          name: 'test',
        },
      });
    }),
  );

  test(
    `${command} start`,
    timeout(async ({rig}) => {
      await assertOptions(rig, `${command} start`, {
        agent,
        script: {
          packageDir: rig.temp,
          name: 'start',
        },
      });
    }),
  );

  test(
    `${command} run main -- --extra`,
    timeout(async ({rig}) => {
      await assertOptions(rig, `${command} run main -- --extra`, {
        agent,
        script: {
          packageDir: rig.temp,
          name: 'main',
        },
        extraArgs: ['--extra'],
      });
    }),
  );

  // Does not work in pnpm, see https://github.com/pnpm/pnpm/issues/4821.
  skipIfPnpm(
    `${command} test -- --extra`,
    timeout(async ({rig}) => {
      await assertOptions(rig, `${command} test -- --extra`, {
        agent,
        script: {
          packageDir: rig.temp,
          name: 'test',
        },
        extraArgs: ['--extra'],
      });
    }),
  );

  test(
    `${command} start -- --extra`,
    timeout(async ({rig}) => {
      await assertOptions(rig, `${command} start -- --extra`, {
        agent,
        script: {
          packageDir: rig.temp,
          name: 'start',
        },
        extraArgs: ['--extra'],
      });
    }),
  );

  test(
    `${command} run main --watch`,
    timeout(async ({rig}) => {
      await assertOptions(rig, `${command} run main --watch`, {
        agent,
        script: {
          packageDir: rig.temp,
          name: 'main',
        },
        watch: true,
      });
    }),
  );

  // Does not work in pnpm, see https://github.com/pnpm/pnpm/issues/4821.
  skipIfPnpm(
    `${command} test --watch`,
    timeout(async ({rig}) => {
      await assertOptions(rig, `${command} test --watch`, {
        agent,
        script: {
          packageDir: rig.temp,
          name: 'test',
        },
        watch: true,
      });
    }),
  );

  test(
    `${command} start --watch`,
    timeout(async ({rig}) => {
      await assertOptions(rig, `${command} start --watch`, {
        agent,
        script: {
          packageDir: rig.temp,
          name: 'start',
        },
        watch: true,
      });
    }),
  );

  test(
    `${command} run main --watch -- --extra`,
    timeout(async ({rig}) => {
      await assertOptions(rig, `${command} run main --watch -- --extra`, {
        agent,
        script: {
          packageDir: rig.temp,
          name: 'main',
        },
        extraArgs: ['--extra'],
        watch: true,
      });
    }),
  );

  // Does not work in pnpm, see https://github.com/pnpm/pnpm/issues/4821.
  skipIfPnpm(
    `${command} test --watch -- --extra`,
    timeout(async ({rig}) => {
      await assertOptions(rig, `${command} test --watch -- --extra`, {
        agent,
        script: {
          packageDir: rig.temp,
          name: 'test',
        },
        extraArgs: ['--extra'],
        watch: true,
      });
    }),
  );

  test(
    `${command} start --watch -- --extra`,
    timeout(async ({rig}) => {
      await assertOptions(rig, `${command} start --watch -- --extra`, {
        agent,
        script: {
          packageDir: rig.temp,
          name: 'start',
        },
        extraArgs: ['--extra'],
        watch: true,
      });
    }),
  );

  test(
    `${command} run recurse -> ${command} run start --watch`,
    timeout(async ({rig}) => {
      await assertOptions(
        rig,
        `${command} run recurse`,
        {
          agent,
          script: {
            packageDir: rig.temp,
            name: 'start',
          },
          extraArgs: [],
          watch: true,
        },
        undefined,
        {
          recurse: `${command} run start --watch`,
        },
      );
    }),
  );

  test(`WIREIT_LOGGER=simple ${command} run main`, async ({rig}) => {
    await assertOptions(
      rig,
      `${command} run main`,
      {
        agent,
        script: {
          packageDir: rig.temp,
          name: 'main',
        },
        logger: 'DefaultLogger',
      },
      {
        WIREIT_LOGGER: 'simple',
      },
    );
  });

  test(`WIREIT_LOGGER=quiet ${command} run main`, async ({rig}) => {
    await assertOptions(
      rig,
      `${command} run main`,
      {
        agent,
        script: {
          packageDir: rig.temp,
          name: 'main',
        },
        logger: 'QuietLogger',
      },
      {
        WIREIT_LOGGER: 'quiet',
      },
    );
  });

  // Doesn't work with yarn 1.x due to
  // https://github.com/yarnpkg/yarn/issues/8905. Anything before a "--" is not
  // included on argv, and the npm_config_argv variable does not let us
  // reconstruct it, because it always reflects the first script in a chain,
  // instead of the current script.
  skipIfYarn(
    `${command} run recurse -> ${command} run start --watch -- --extra`,
    timeout(async ({rig}) => {
      await assertOptions(
        rig,
        `${command} run recurse`,
        {
          agent,
          script: {
            packageDir: rig.temp,
            name: 'start',
          },
          extraArgs: ['--extra'],
          watch: true,
        },
        undefined,
        {
          recurse: `${command} run start --watch -- --extra`,
        },
      );
    }),
  );
}

test.run();
