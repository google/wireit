/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'os';
import * as fs from 'fs/promises';
import * as pathlib from 'path';
import {Result} from './error.js';
import {DefaultLogger} from './logging/default-logger.js';
import {ScriptReference} from './script.js';
import {FailureMode} from './executor.js';
import {unreachable} from './util/unreachable.js';

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

export const logger = new DefaultLogger(packageDir ?? process.cwd());

export interface Options {
  script: ScriptReference;
  watch: boolean;
  extraArgs: string[] | undefined;
  numWorkers: number;
  cache: 'local' | 'github' | 'none';
  failureMode: FailureMode;
}

export const getOptions = (): Result<Options> => {
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
    const defaultValue = os.cpus().length * 4;
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

  let curArg = 2; // Skip over "node" and the "wireit" binary.
  const watch = process.argv[curArg] === 'watch';
  if (watch) {
    curArg++;
  }
  let extraArgs = undefined;
  if (process.argv.length > curArg) {
    if (process.argv[curArg] === '--') {
      curArg++;
      extraArgs = process.argv.slice(curArg);
    } else {
      const unrecognized = process.argv.slice(curArg);
      return {
        ok: false,
        error: {
          reason: 'invalid-usage',
          message:
            `Unrecognized Wireit argument(s) ${JSON.stringify(
              unrecognized
            )}. ` +
            `To pass arguments to the command, use two sets of double-dashes, ` +
            `e.g. "npm run build -- -- --extra-arg"`,
          script,
          type: 'failure',
        },
      };
    }
  }

  return {
    ok: true,
    value: {
      script,
      watch,
      extraArgs,
      numWorkers: numWorkersResult.value,
      cache: cacheResult.value,
      failureMode: failureModeResult.value,
    },
  };
};
