/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'os';
import * as fs from './util/fs.js';
import * as pathlib from 'path';
import {Result} from './error.js';
import {MetricsLogger} from './logging/metrics-logger.js';
import {ScriptReference} from './config.js';
import {FailureMode} from './executor.js';
import {unreachable} from './util/unreachable.js';
import {Logger} from './logging/logger.js';
import {QuietCiLogger, QuietLogger} from './logging/quiet-logger.js';
import {DefaultLogger} from './logging/default-logger.js';

export const packageDir = await (async (): Promise<string | undefined> => {
  // Recent versions of npm set this environment variable that tells us the
  // package.
  const packageJsonPath = process.env.npm_package_json;
  if (packageJsonPath) {
    return pathlib.dirname(packageJsonPath);
  }
  // Older versions of npm, as well as yarn and pnpm, don't set this variable,
  // so we have to find the nearest package.json by walking up the filesystem.
  let maybePackageDir = process.cwd();
  while (true) {
    try {
      await fs.stat(pathlib.join(maybePackageDir, 'package.json'));
      return maybePackageDir;
    } catch (error) {
      const {code} = error as {code: string};
      if (code !== 'ENOENT') {
        throw code;
      }
    }
    const parent = pathlib.dirname(maybePackageDir);
    if (parent === maybePackageDir) {
      // Reached the root of the filesystem, no package.json.
      return undefined;
    }
    maybePackageDir = parent;
  }
})();

export type Agent = 'npm' | 'pnpm' | 'yarnClassic' | 'yarnBerry';

export interface Options {
  script: ScriptReference;
  watch: boolean;
  extraArgs: string[] | undefined;
  numWorkers: number;
  cache: 'local' | 'github' | 'none';
  failureMode: FailureMode;
  agent: Agent;
  logger: Logger;
}

export const getOptions = async (): Promise<Result<Options>> => {
  // This environment variable is set by npm, yarn, and pnpm, and tells us which
  // script is running.
  const scriptName = process.env.npm_lifecycle_event;
  // We need to handle "npx wireit" as a special case, because it sets
  // "npm_lifecycle_event" to "npx". The "npm_execpath" will be "npx-cli.js",
  // though, so we use that combination to detect this special case.
  const launchedWithNpx =
    scriptName === 'npx' && process.env.npm_execpath?.endsWith('npx-cli.js');
  if (!packageDir || !scriptName || launchedWithNpx) {
    const detail = [];
    if (!packageDir) {
      detail.push('Wireit could not find a package.json.');
    }
    if (!scriptName) {
      detail.push('Wireit could not identify the script to run.');
    }
    if (launchedWithNpx) {
      detail.push('Launching Wireit with npx is not supported.');
    }
    return {
      ok: false,
      error: {
        type: 'failure',
        reason: 'launched-incorrectly',
        script: {packageDir: packageDir ?? process.cwd()},
        detail: detail.join(' '),
      },
    };
  }
  const script = {packageDir, name: scriptName};

  const numWorkersResult = ((): Result<number> => {
    const workerString = process.env['WIREIT_PARALLEL'] ?? '';
    // Many scripts will be IO blocked rather than CPU blocked, so running
    // multiple scripts per CPU will help keep things moving.
    const defaultValue = os.cpus().length * 2;
    if (workerString.match(/^infinity$/i)) {
      return {ok: true, value: Infinity};
    }
    if (workerString == null || workerString === '') {
      return {ok: true, value: defaultValue};
    }
    const parsedInt = parseInt(workerString, 10);
    if (Number.isNaN(parsedInt) || parsedInt <= 0) {
      return {
        ok: false,
        error: {
          reason: 'invalid-usage',
          message:
            `Expected the WIREIT_PARALLEL env variable to be ` +
            `a positive integer, got ${JSON.stringify(workerString)}`,
          script,
          type: 'failure',
        },
      };
    }
    return {ok: true, value: parsedInt};
  })();
  if (!numWorkersResult.ok) {
    return numWorkersResult;
  }

  const cacheResult = ((): Result<'none' | 'local' | 'github'> => {
    const str = process.env['WIREIT_CACHE'];
    if (str === undefined) {
      // The CI variable is a convention that is automatically set by GitHub
      // Actions [0], Travis [1], and other CI (continuous integration)
      // providers.
      //
      // [0] https://docs.github.com/en/actions/learn-github-actions/environment-variables#default-environment-variables
      // [1] https://docs.travis-ci.com/user/environment-variables/#default-environment-variables
      //
      // If we're on CI, we don't want "local" caching, because anything we
      // store locally will be lost when the VM shuts down.
      //
      // We also don't want "github", because (even if we also detected that
      // we're specifically on GitHub) we should be cautious about using up
      // storage quota, and instead require opt-in via WIREIT_CACHE=github.
      const ci = process.env['CI'] === 'true';
      return {ok: true, value: ci ? 'none' : 'local'};
    }
    if (str === 'local' || str === 'github' || str === 'none') {
      return {ok: true, value: str};
    }
    return {
      ok: false,
      error: {
        reason: 'invalid-usage',
        message:
          `Expected the WIREIT_CACHE env variable to be ` +
          `"local", "github", or "none", got ${JSON.stringify(str)}`,
        script,
        type: 'failure',
      },
    };
  })();
  if (!cacheResult.ok) {
    return cacheResult;
  }

  const failureModeResult = ((): Result<FailureMode> => {
    const str = process.env['WIREIT_FAILURES'];
    if (!str) {
      return {ok: true, value: 'no-new'};
    }
    if (str === 'no-new' || str === 'continue' || str === 'kill') {
      return {ok: true, value: str};
    }
    return {
      ok: false,
      error: {
        reason: 'invalid-usage',
        message:
          `Expected the WIREIT_FAILURES env variable to be ` +
          `"no-new", "continue", or "kill", got ${JSON.stringify(str)}`,
        script,
        type: 'failure',
      },
    };
  })();
  if (!failureModeResult.ok) {
    return failureModeResult;
  }

  const agent = getNpmUserAgent();

  const loggerResult = await (async (): Promise<Result<Logger>> => {
    const packageRoot = packageDir ?? process.cwd();
    const str = process.env['WIREIT_LOGGER'];
    if (!str) {
      return {ok: true, value: new DefaultLogger(packageRoot)};
    }
    if (str === 'quiet') {
      return {ok: true, value: new QuietLogger(packageRoot)};
    }
    if (str === 'quiet-ci') {
      return {ok: true, value: new QuietCiLogger(packageRoot)};
    }
    if (str === 'explain') {
      const {ExplainLogger} = await import('./logging/explain-logger.js');
      return {ok: true, value: new ExplainLogger(packageRoot)};
    }
    if (str === 'simple') {
      return {ok: true, value: new DefaultLogger(packageRoot)};
    }
    if (str === 'metrics') {
      return {ok: true, value: new MetricsLogger(packageRoot)};
    }
    return {
      ok: false,
      error: {
        reason: 'invalid-usage',
        message:
          `Expected the WIREIT_LOGGER env variable to be ` +
          `"quiet", "quiet-ci", "explain", "simple", or "metrics", got ${JSON.stringify(
            str,
          )}`,
        script,
        type: 'failure',
      },
    };
  })();
  if (!loggerResult.ok) {
    return loggerResult;
  }

  return {
    ok: true,
    value: {
      script,
      numWorkers: numWorkersResult.value,
      cache: cacheResult.value,
      failureMode: failureModeResult.value,
      agent,
      logger: loggerResult.value,
      ...getArgvOptions(script, agent),
    },
  };
};

/**
 * Get options that are set as command-line arguments.
 */
function getArgvOptions(
  script: ScriptReference,
  agent: Agent,
): Pick<Options, 'watch' | 'extraArgs'> {
  // The way command-line arguments are handled in npm, yarn, and pnpm are all
  // different. Our goal here is for `<agent> --watch -- --extra` to behave the
  // same in all agents.
  switch (agent) {
    case 'npm': {
      // npm 6.14.17
      //   - Arguments before the "--" in "--flag" style turn into "npm_config_<flag>"
      //     environment variables.
      //   - Arguments before the "--" in "plain" style go to argv.
      //   - Arguments after "--" go to argv.
      //   - The "npm_config_argv" environment variable contains full details as JSON.
      //
      // npm 8.11.0
      //   - Like npm 6, except there is no "npm_config_argv" environment variable.
      return {
        watch: process.env['npm_config_watch'] !== undefined,
        extraArgs: process.argv.slice(2),
      };
    }
    case 'yarnClassic': {
      // yarn 1.22.18
      //   - If there is no "--", all arguments go to argv.
      //   - If there is a "--", arguments in "--flag" style before it are eaten,
      //     arguments in "plain" style before it go to argv, and all arguments after
      //     it go to argv. Also a warning is emitted saying "In a future version, any
      //     explicit "--" will be forwarded as-is to the scripts."
      //   - The "npm_config_argv" environment variable contains full details as JSON,
      //     but unlike npm 6, it reflects the first script in a chain of scripts, instead
      //     of the last.
      return parseRemainingArgs(
        findRemainingArgsFromNpmConfigArgv(script, agent),
      );
    }
    case 'yarnBerry':
    case 'pnpm': {
      // yarn 3.2.1
      //   - Arguments before the script name are yarn arguments and error if unknown.
      //   - Arguments after the script name go to argv.
      // pnpm 7.1.7
      //   - Arguments before the script name are pnpm arguments and error if unknown.
      //   - Arguments after the script name go to argv.
      return parseRemainingArgs(process.argv.slice(2));
    }
    default: {
      throw new Error(`Unhandled npm agent: ${unreachable(agent) as string}`);
    }
  }
}

/**
 * Try to find the npm user agent being used. If we can't detect it, assume npm.
 */
function getNpmUserAgent(): Agent {
  const userAgent = process.env['npm_config_user_agent'];
  if (userAgent !== undefined) {
    const match = userAgent.match(/^(npm|yarn|pnpm)\//);
    if (match !== null) {
      if (match[1] === 'yarn') {
        return /^yarn\/[01]\./.test(userAgent) ? 'yarnClassic' : 'yarnBerry';
      }

      return match[1] as 'npm' | 'pnpm';
    }
  }
  console.error(
    '⚠️ Wireit could not identify the npm user agent, ' +
      'assuming it behaves like npm. ' +
      'Arguments may not be interpreted correctly.',
  );
  return 'npm';
}

/**
 * Parses the `npm_config_argv` environment variable to find the command-line
 * arguments that follow the main arguments. For example, given the result of
 * `"yarn run build --watch -- --extra"`, return `["--watch", "--", "--extra"]`.
 */
function findRemainingArgsFromNpmConfigArgv(
  script: ScriptReference,
  agent: Agent,
): string[] {
  const configArgvStr = process.env['npm_config_argv'];
  if (!configArgvStr) {
    console.error(
      '⚠️ The "npm_config_argv" environment variable was not set. ' +
        'Arguments may not be interpreted correctly.',
    );
    return [];
  }
  let configArgv: {
    /**  Seems to always be empty in Yarn. */
    remain: string[];
    /**
     * E.g. `["run", "main"]`. In Yarn, the first item is always "run", even
     * when using `yarn test` or `yarn start`.
     */
    cooked: string[];
    /** E.g. `["run", "main", "--watch", "--", "--extra"]` */
    original: string[];
  };
  try {
    configArgv = JSON.parse(configArgvStr) as typeof configArgv;
  } catch {
    console.error(
      '⚠️ Wireit could not parse the "npm_config_argv" ' +
        'environment variable as JSON. ' +
        'Arguments may not be interpreted correctly.',
    );
    return [];
  }
  // Since the "remain" and "cooked" arrays are unreliable in Yarn, the only
  // reliable way to find the remaining args is to look for where the script
  // name first appeared in the "original" array.
  const scriptNameIdx = configArgv.original.indexOf(script.name);
  if (scriptNameIdx === -1) {
    // We're probably dealing with a recursive situation where one yarn 1.x
    // script is calling another, such as `"watch": "yarn run build --watch"`.
    //
    // Usually we would handle this situation by looking at the original raw
    // arguments provided by the "npm_config_argv" environment variable, but in
    // the recursive case we can't do that, because due to
    // https://github.com/yarnpkg/yarn/issues/8905 that variable reflects the
    // first script in the chain, instead of the current script (unlike npm 6.x
    // which does it correctly).
    //
    // So instead, we'll log a warning and at least handle the case where there
    // is no "--" argument. If there is no "--" argument, then argv will contain
    // all arguments. However, if there was a "--" argument, then all arguments
    // before the "--" are lost, and argv only contains the arguments after the
    // "--" (e.g. `yarn run build --watch` works fine, but `yarn run build
    // --watch -- --extra` loses the `--watch`).
    console.error(
      '⚠️ Wireit could not find the script name in ' +
        'the "npm_config_argv" environment variable. ' +
        'Arguments may not be interpreted correctly. ' +
        (agent === 'yarnClassic'
          ? `See https://github.com/yarnpkg/yarn/issues/8905, ` +
            `and please consider upgrading to yarn 3.x or switching to npm.`
          : ''),
    );
    return process.argv.slice(2);
  }
  return configArgv.original.slice(scriptNameIdx + 1);
}

/**
 * Given a list of remaining command-line arguments (the arguments after e.g.
 * "yarn run build"), parse out the arguments that are Wireit options, warn
 * about any unrecognized options, and return everything after a `"--"` argument
 * as `extraArgs` to be passed down to the script.
 */
function parseRemainingArgs(
  args: string[],
): Pick<Options, 'watch' | 'extraArgs'> {
  let watch = false;
  let extraArgs: string[] = [];
  const unrecognized = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      extraArgs = args.slice(i + 1);
      break;
    } else if (arg === '--watch') {
      watch = true;
    } else {
      unrecognized.push(arg);
    }
  }
  if (unrecognized.length > 0) {
    console.error(
      `⚠️ Unrecognized Wireit argument(s): ` +
        unrecognized.map((arg) => JSON.stringify(arg)).join(', ') +
        `. To pass arguments to the script, use a double-dash, ` +
        `e.g. "npm run build -- --extra".`,
    );
  }
  return {
    watch,
    extraArgs,
  };
}
