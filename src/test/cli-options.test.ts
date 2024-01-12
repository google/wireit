/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'uvu/assert';
import * as pathlib from 'path';
import {Agent, Options} from '../cli-options.js';
import {IS_WINDOWS} from '../util/windows.js';
import {injectYarnBerryToRig} from './util/yarn-berry.js';
import {Result} from '../error.js';
import {WireitTestRig} from './util/test-rig.js';
import {rigTest} from './util/rig-test.js';
import {suite} from 'uvu';

const test = suite<object>();

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
  rig.env.WIREIT_DEBUG_LOG_FILE = '';

  if (command.startsWith('yarnBerry')) {
    // `yarn` chooses whether to use "classic" or "berry" based on the presence
    // of `yarnPath` in `.yarnrc.yml`.
    //
    // To closest simulate a user's environment, set `yarnPath` and let the
    // global `yarn` command pick it when testing `yarnBerry`.
    command = command.replace(/yarnBerry/g, 'yarn');

    extraScripts = Object.fromEntries(
      Object.entries(extraScripts || {}).map(([scriptName, scriptCommand]) => [
        scriptName,
        scriptCommand.replace(/yarnBerry/g, 'yarn'),
      ]),
    );

    await injectYarnBerryToRig(rig);
  }

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

  env = {
    ...env,
    WIREIT_DEBUG_LOG_FILE: '',
  };

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

// yarnBerry tests work everywhere but Windows (#1014).  Until Windows testing
// is fixed, skip yarnBerry tests on Windows to prevent CI failures.
const commands = (['npm', 'yarn', 'pnpm', 'yarnBerry'] as const).filter(
  (command) => !IS_WINDOWS || command !== 'yarnBerry',
);

for (const command of commands) {
  const agent: Agent = command === 'yarn' ? 'yarnClassic' : command;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const skipIfYarn = command === 'yarn' ? test.skip : test;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const skipIfPnpm = command === 'pnpm' ? test.skip : test;

  test(
    `${command} run main`,
    rigTest(async ({rig}) => {
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
    rigTest(async ({rig}) => {
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
    rigTest(async ({rig}) => {
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
    rigTest(async ({rig}) => {
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
    rigTest(async ({rig}) => {
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
    rigTest(async ({rig}) => {
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
    rigTest(async ({rig}) => {
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
    rigTest(async ({rig}) => {
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
    rigTest(async ({rig}) => {
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
    rigTest(async ({rig}) => {
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
    rigTest(async ({rig}) => {
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
    rigTest(async ({rig}) => {
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
    rigTest(async ({rig}) => {
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

  test(
    `WIREIT_LOGGER=simple ${command} run main`,
    rigTest(async ({rig}) => {
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
    }),
  );

  test(
    `WIREIT_LOGGER=quiet ${command} run main`,
    rigTest(async ({rig}) => {
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
    }),
  );

  // Doesn't work with yarn 1.x due to
  // https://github.com/yarnpkg/yarn/issues/8905. Anything before a "--" is not
  // included on argv, and the npm_config_argv variable does not let us
  // reconstruct it, because it always reflects the first script in a chain,
  // instead of the current script.
  skipIfYarn(
    `${command} run recurse -> ${command} run start --watch -- --extra`,
    rigTest(async ({rig}) => {
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
