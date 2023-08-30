/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import {timeout} from './util/uvu-timeout.js';
import {WireitTestRig} from './util/test-rig.js';
import {checkScriptOutput} from './util/check-script-output.js';
import assert from 'assert';

const test = suite<{rig: WireitTestRig}>();

test.before.each(async (ctx) => {
  try {
    ctx.rig = new WireitTestRig();
    ctx.rig.env['WIREIT_LOGGER'] = 'metrics';
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
  'logs metrics for successful events',
  timeout(async ({rig}) => {
    const cmdA = await rig.newCommand();
    const cmdB = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            dependencies: ['b'],
            files: ['a.txt'],
            output: [],
          },
          b: {
            command: cmdB.command,
            files: ['b.txt'],
            output: [],
          },
        },
      },
      'a.txt': 'v0',
    });

    // Initial execution. Both A and B run.
    {
      const exec = rig.exec('npm run a');
      const invB = await cmdB.nextInvocation();
      invB.exit(0);
      const invA = await cmdA.nextInvocation();
      invA.exit(0);
      const {stdout} = await exec.exit;

      assertNthMetric(0, stdout, {total: 2, ran: 2, percentRan: 100});
    }

    // Input to A is changed, so A runs again. B is a dependency of A, but it is
    // unchanged, so B is fresh.
    {
      await rig.write('a.txt', 'v1');
      const exec = rig.exec('npm run a');
      const invA = await cmdA.nextInvocation();
      invA.exit(0);
      const {stdout} = await exec.exit;

      assertNthMetric(0, stdout, {
        total: 2,
        ran: 1,
        percentRan: 50,
        fresh: 1,
        percentFresh: 50,
      });
    }

    // Input to A is changed back to 'v0', so A is cached. B is a dependency of A,
    // but it is still unchanged, so B is fresh.
    {
      await rig.write('a.txt', 'v0');
      const exec = rig.exec('npm run a');
      const {stdout} = await exec.exit;

      assertNthMetric(0, stdout, {
        total: 2,
        fresh: 1,
        percentFresh: 50,
        cached: 1,
        percentCached: 50,
      });
    }
  })
);

test(
  'does not log metrics for non-success events',
  timeout(async ({rig}) => {
    const cmdA = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
          },
        },
      },
    });

    // Script fails for unknown reason
    const exec = rig.exec('npm run a');
    const inv = await cmdA.nextInvocation();
    inv.exit(1);
    const {stdout} = await exec.exit;

    // There should be no metrics in the output.
    assert.equal([...stdout.matchAll(/🏁/gi)].length, 0);
  })
);

test(
  'logs metrics for interesting iterations when in watch mode',
  timeout(async ({rig}) => {
    const cmdA = await rig.newCommand();
    const cmdB = await rig.newCommand();
    await rig.writeAtomic({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            dependencies: ['b'],
            files: ['a.txt'],
            output: [],
          },
          b: {
            command: cmdB.command,
            files: ['b.txt'],
            output: [],
          },
        },
      },
      'a.txt': 'v0',
      'b.txt': 'v0',
    });

    const exec = rig.exec('npm run a --watch');

    // Initial execution. Both A and B run.
    {
      const invB = await cmdB.nextInvocation();
      invB.exit(0);
      const invA = await cmdA.nextInvocation();
      invA.exit(0);
      assert.equal(cmdA.numInvocations, 1);
      assert.equal(cmdB.numInvocations, 1);
    }

    // Input to A is changed, so A runs again. B is a dependency of A, but it is
    // unchanged, so B is fresh.
    {
      await rig.writeAtomic({
        'a.txt': 'v1',
      });
      const invA = await cmdA.nextInvocation();
      invA.exit(0);
    }

    // Wait a moment to give the watcher time to react.
    await new Promise((resolve) => setTimeout(resolve, 100));
    exec.kill();
    const {stdout} = await exec.exit;

    assert.equal([...stdout.matchAll(/🏁/gi)].length, 3);
    assertNthMetric(0, stdout, {total: 1, ran: 1, percentRan: 100});
    assertNthMetric(1, stdout, {total: 1, ran: 1, percentRan: 100});
    assertNthMetric(2, stdout, {
      total: 2,
      ran: 1,
      percentRan: 50,
      fresh: 1,
      percentFresh: 50,
    });
  })
);

test(
  'does not log metrics for non-interesting iterations in watch mode',
  timeout(async ({rig}) => {
    const cmdA = await rig.newCommand();
    await rig.writeAtomic({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: cmdA.command,
            files: ['a.txt'],
            output: [],
          },
        },
      },
      'a.txt': 'v0',
    });

    const exec = rig.exec('npm run a --watch');

    // Initial execution. A should run.
    const inv = await cmdA.nextInvocation();
    inv.exit(0);

    // Input to A is changed, but has the same content as before. This is not an
    // 'interesting' iteration, so metrics shouldn't be logged.
    await rig.writeAtomic('a.txt', 'v0');

    // Wait a moment to give the watcher time to react.
    await new Promise((resolve) => setTimeout(resolve, 100));
    exec.kill();
    const {stdout} = await exec.exit;

    // There should only be one metrics entry in stdout.
    assert.equal([...stdout.matchAll(/\[metrics\]/gi)].length, 1);
    assertNthMetric(0, stdout, {total: 1, ran: 1, percentRan: 100});
  })
);

/**
 * Asserts that the nth metric in stdout exists and matches the given arguments.
 */
function assertNthMetric(
  n: number,
  stdout: string,
  args: {
    total?: number;
    ran?: number;
    percentRan?: number;
    fresh?: number;
    percentFresh?: number;
    cached?: number;
    percentCached?: number;
  }
): void {
  const metric = findNthMetric(n, stdout);

  if (!metric) {
    throw new Error(`Could not find metric ${n}`);
  }

  const actual = replaceTimeWithWildcard(metric);
  const expected = buildExpectedMetric(args);

  checkScriptOutput(actual, expected);
}

function findNthMetric(n: number, stdout: string): string | undefined {
  const lines = stdout.split('\n');
  const metricLength = 4;

  let count = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('🏁 [metrics]')) {
      count++;

      if (count === n) {
        return lines.slice(i, i + metricLength).join('\n');
      }
    }
  }
}

function buildExpectedMetric(args: {
  total?: number;
  ran?: number;
  percentRan?: number;
  fresh?: number;
  percentFresh?: number;
  cached?: number;
  percentCached?: number;
}): string {
  return `🏁 [metrics] Executed ${args.total ?? 0} script(s) in * seconds
\tRan                 : ${args.ran ?? 0} (${args.percentRan ?? 0}%)
\tSkipped (fresh)     : ${args.fresh ?? 0} (${args.percentFresh ?? 0}%)
\tRestored from cache : ${args.cached ?? 0} (${args.percentCached ?? 0}%)
`;
}

/**
 * Replaces the 'seconds' value in the metric with '*'. We are not interested
 * in asserting on the exact time.
 */
function replaceTimeWithWildcard(metric: string): string {
  const words = metric.split(' ');

  for (let i = 0; i < words.length; i++) {
    if (words[i].startsWith('seconds')) {
      words[i - 1] = '*';
      break;
    }
  }

  return words.join(' ');
}

test.run();
