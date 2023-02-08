import {suite} from 'uvu';
import {timeout} from './util/uvu-timeout.js';
import {WireitTestRig} from './util/test-rig.js';
import {checkScriptOutput} from './util/check-script-output.js';

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
  'logs summary metrics for success events',
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
      'b.txt': 'v0',
    });

    // A: runs for the first time
    // B: runs for the first time
    {
      const exec = rig.exec('npm run a');
      const invB = await cmdB.nextInvocation();
      invB.exit(0);
      const invA = await cmdA.nextInvocation();
      invA.exit(0);
      const res = await exec.exit;

      assertSummary(res.stdout, {
        total: 2,
        ran: 2,
        percentRan: 100,
      });
    }

    // A: input changed, so runs again
    // B: nothing changed, so still 'fresh'
    {
      await rig.write('a.txt', 'v1');
      const exec = rig.exec('npm run a');
      const invA = await cmdA.nextInvocation();
      invA.exit(0);
      const res = await exec.exit;

      assertSummary(res.stdout, {
        total: 2,
        ran: 1,
        percentRan: 50,
        fresh: 1,
        percentFresh: 50,
      });
    }

    // A: input changed back to 'v0', so 'cached'
    // B: nothing changed, so still 'fresh'
    {
      await rig.write('a.txt', 'v0');
      const exec = rig.exec('npm run a');
      const res = await exec.exit;

      assertSummary(res.stdout, {
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
  'does not log summary metrics for non-success events',
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
    {
      const exec = rig.exec('npm run a');
      const inv = await cmdA.nextInvocation();
      inv.exit(1);
      const res = await exec.exit;
      assertSummary(res.stdout, {});
    }
  })
);

function assertSummary(
  actual: string,
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
  const expected = `🏁 [summary] Executed ${
    args.total ?? 0
  } script(s) in * seconds
    Ran:              ${args.ran ?? 0} (${args.percentRan ?? 0}%)
    Skipped (fresh):  ${args.fresh ?? 0} (${args.percentFresh ?? 0}%)
    Skipped (cached): ${args.cached ?? 0} (${args.percentCached ?? 0}%)
`;

  const actualSummary = actual
    .slice(actual.indexOf('🏁'))
    .replace(/\d+\.\d{2}/g, '*'); // replaces numbers w/ two decimals with '*'

  checkScriptOutput(actualSummary, expected);
}

test.run();
