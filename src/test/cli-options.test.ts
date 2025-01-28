/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {Options, type Agent} from '../cli-options.js';
import {Result} from '../error.js';
import {NODE_MAJOR_VERSION} from './util/node-version.js';
import {rigTest} from './util/rig-test.js';
import {WireitTestRig} from './util/test-rig.js';

/* eslint-disable @typescript-eslint/unbound-method */

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
  await rig.write({
    'package.json': {
      scripts: {
        main: TEST_BINARY_COMMAND,
        test: TEST_BINARY_COMMAND,
        start: TEST_BINARY_COMMAND,
        other: TEST_BINARY_COMMAND,
        ...extraScripts,
      },
    },
  });
  env = {...env, WIREIT_DEBUG_LOG_FILE: ''};
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

interface AgentCommands {
  agent: Agent;
  runCmd: string;
  testCmd: string | undefined;
  startCmd: string | undefined;
  /**
   * Whether this agent needs an extra set of "--" before arguments will be
   * passed down to Wireit.
   */
  needsExtraDashes: boolean;
}

const commands: AgentCommands[] = [
  {
    agent: 'npm',
    runCmd: 'npm run',
    testCmd: 'npm test',
    startCmd: 'npm start',
    needsExtraDashes: false,
  },
  {
    agent: 'nodeRun',
    runCmd: 'node --run',
    testCmd: undefined,
    startCmd: undefined,
    needsExtraDashes: true,
  },
  {
    agent: 'yarnClassic',
    runCmd: 'yarn run',
    testCmd: 'yarn test',
    startCmd: 'yarn start',
    needsExtraDashes: false,
  },
  {
    agent: 'pnpm',
    runCmd: 'pnpm run',
    testCmd: 'pnpm test',
    startCmd: 'pnpm start',
    needsExtraDashes: false,
  },
];

for (const {agent, runCmd, testCmd, startCmd, needsExtraDashes} of commands) {
  if (agent === 'nodeRun' && NODE_MAJOR_VERSION < 22) {
    // node --run was added in Node 22.
    continue;
  }

  const isYarn = agent === 'yarnClassic';
  const isPnpm = agent === 'pnpm';
  const isWindows = process.platform === 'win32';
  const extraDashes = needsExtraDashes ? '--' : '';

  test(
    `${agent} run`,
    rigTest(async ({rig}) => {
      await assertOptions(rig, `${runCmd} main`, {
        agent,
        script: {
          packageDir: rig.temp,
          name: 'main',
        },
      });
    }),
  );

  test(
    `${agent} run --extra`,
    rigTest(async ({rig}) => {
      await assertOptions(rig, `${runCmd} main -- ${extraDashes} --extra`, {
        agent,
        script: {
          packageDir: rig.temp,
          name: 'main',
        },
        extraArgs: ['--extra'],
      });
    }),
  );

  test(
    `${agent} run --watch`,
    rigTest(async ({rig}) => {
      await assertOptions(rig, `${runCmd} main ${extraDashes} --watch`, {
        agent,
        script: {
          packageDir: rig.temp,
          name: 'main',
        },
        watch: {strategy: 'event'},
      });
    }),
  );

  test(
    `${agent} run --watch --extra`,
    rigTest(async ({rig}) => {
      await assertOptions(
        rig,
        `${runCmd} main ${extraDashes} --watch -- --extra`,
        {
          agent,
          script: {
            packageDir: rig.temp,
            name: 'main',
          },
          extraArgs: ['--extra'],
          watch: {strategy: 'event'},
        },
      );
    }),
  );

  // https://github.com/google/wireit/issues/1168
  (isWindows ? test.skip : test)(
    `${agent} run recurse -> run other --watch`,
    rigTest(async ({rig}) => {
      await assertOptions(
        rig,
        `${runCmd} recurse`,
        {
          agent,
          script: {
            packageDir: rig.temp,
            name: 'other',
          },
          extraArgs: [],
          watch: {strategy: 'event'},
        },
        undefined,
        {
          recurse: `${runCmd} other ${extraDashes} --watch`,
        },
      );
    }),
  );

  test(
    `${agent} WIREIT_LOGGER=simple run`,
    rigTest(async ({rig}) => {
      await assertOptions(
        rig,
        `${runCmd} main`,
        {
          agent,
          script: {
            packageDir: rig.temp,
            name: 'main',
          },
          logger: 'SimpleLogger',
        },
        {
          WIREIT_LOGGER: 'simple',
        },
      );
    }),
  );

  test(
    `${agent} WIREIT_LOGGER=quiet run`,
    rigTest(async ({rig}) => {
      await assertOptions(
        rig,
        `${runCmd} main`,
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
  (isYarn || isWindows ? test.skip : test)(
    `${agent} run recurse -> run other --watch --extra`,
    rigTest(async ({rig}) => {
      await assertOptions(
        rig,
        `${runCmd} recurse`,
        {
          agent,
          script: {
            packageDir: rig.temp,
            name: 'other',
          },
          extraArgs: ['--extra'],
          watch: {strategy: 'event'},
        },
        undefined,
        {
          recurse: `${runCmd} other ${extraDashes} --watch -- --extra`,
        },
      );
    }),
  );

  if (testCmd !== undefined) {
    test(
      `${agent} test`,
      rigTest(async ({rig}) => {
        await assertOptions(rig, `${testCmd}`, {
          agent,
          script: {
            packageDir: rig.temp,
            name: 'test',
          },
        });
      }),
    );

    // Does not work in pnpm, see https://github.com/pnpm/pnpm/issues/4821.
    (isPnpm ? test.skip : test)(
      `${agent} test --extra`,
      rigTest(async ({rig}) => {
        await assertOptions(rig, `${testCmd} -- --extra`, {
          agent,
          script: {
            packageDir: rig.temp,
            name: 'test',
          },
          extraArgs: ['--extra'],
        });
      }),
    );

    // Does not work in pnpm, see https://github.com/pnpm/pnpm/issues/4821.
    (isPnpm ? test.skip : test)(
      `${agent} test --watch`,
      rigTest(async ({rig}) => {
        await assertOptions(rig, `${testCmd} --watch`, {
          agent,
          script: {
            packageDir: rig.temp,
            name: 'test',
          },
          watch: {strategy: 'event'},
        });
      }),
    );

    // Does not work in pnpm, see https://github.com/pnpm/pnpm/issues/4821.
    (isPnpm ? test.skip : test)(
      `${agent} test --watch --extra`,
      rigTest(async ({rig}) => {
        await assertOptions(rig, `${testCmd} --watch -- --extra`, {
          agent,
          script: {
            packageDir: rig.temp,
            name: 'test',
          },
          extraArgs: ['--extra'],
          watch: {strategy: 'event'},
        });
      }),
    );
  }

  if (startCmd !== undefined) {
    test(
      `${agent} start`,
      rigTest(async ({rig}) => {
        await assertOptions(rig, startCmd, {
          agent,
          script: {
            packageDir: rig.temp,
            name: 'start',
          },
        });
      }),
    );

    test(
      `${agent} start --extra`,
      rigTest(async ({rig}) => {
        await assertOptions(rig, `${startCmd} -- --extra`, {
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
      `${agent} start --watch`,
      rigTest(async ({rig}) => {
        await assertOptions(rig, `${startCmd} --watch`, {
          agent,
          script: {
            packageDir: rig.temp,
            name: 'start',
          },
          watch: {strategy: 'event'},
        });
      }),
    );

    test(
      `${agent} start --watch --extra`,
      rigTest(async ({rig}) => {
        await assertOptions(rig, `${startCmd} --watch -- --extra`, {
          agent,
          script: {
            packageDir: rig.temp,
            name: 'start',
          },
          extraArgs: ['--extra'],
          watch: {strategy: 'event'},
        });
      }),
    );
  }

  test(
    `${agent} --watch WIREIT_WATCH_STRATEGY=poll`,
    rigTest(async ({rig}) => {
      await assertOptions(
        rig,
        `${runCmd} main ${extraDashes} --watch`,
        {
          agent,
          script: {
            packageDir: rig.temp,
            name: 'main',
          },
          logger: 'QuietLogger',
          watch: {
            strategy: 'poll',
            interval: 500,
          },
        },
        {
          WIREIT_WATCH_STRATEGY: 'poll',
        },
      );
    }),
  );

  test(
    `${agent} --watch WIREIT_WATCH_STRATEGY=poll WIREIT_WATCH_POLL_MS=74`,
    rigTest(async ({rig}) => {
      await assertOptions(
        rig,
        `${runCmd} main ${extraDashes} --watch`,
        {
          agent,
          script: {
            packageDir: rig.temp,
            name: 'main',
          },
          logger: 'QuietLogger',
          watch: {
            strategy: 'poll',
            interval: 74,
          },
        },
        {
          WIREIT_WATCH_STRATEGY: 'poll',
          WIREIT_WATCH_POLL_MS: '74',
        },
      );
    }),
  );

  test(
    `${agent} WIREIT_WATCH_STRATEGY=poll WIREIT_WATCH_POLL_MS=74`,
    rigTest(async ({rig}) => {
      await assertOptions(
        rig,
        `${runCmd} main ${extraDashes}`,
        {
          agent,
          script: {
            packageDir: rig.temp,
            name: 'main',
          },
          logger: 'QuietLogger',
          // This is just testing that the WIREIT_WATCH environment variables
          // don't actually turn on watch mode. Only the --watch flag does that.
          watch: false,
        },
        {
          WIREIT_WATCH_STRATEGY: 'poll',
          WIREIT_WATCH_POLL_MS: '74',
        },
      );
    }),
  );
}

test.run();
