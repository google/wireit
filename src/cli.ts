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
import {Analyzer} from './analyzer.js';
import {Executor} from './executor.js';
import {WorkerPool} from './util/worker-pool.js';
import {unreachable} from './util/unreachable.js';
import {Deferred} from './util/deferred.js';

import type {ScriptReference} from './script.js';
import type {Failure} from './event.js';
import type {FailureMode} from './executor.js';

const packageDir = await (async (): Promise<string | undefined> => {
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

const logger = new DefaultLogger(packageDir ?? process.cwd());

interface Options {
  script: ScriptReference;
  watch: boolean;
  numWorkers: number;
  cache: 'local' | 'github' | 'none';
  failureMode: FailureMode;
}

const getOptions = (): Result<Options> => {
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

  return {
    ok: true,
    value: {
      script,
      watch: process.argv[2] === 'watch',
      numWorkers: numWorkersResult.value,
      cache: cacheResult.value,
      failureMode: failureModeResult.value,
    },
  };
};

const run = async (): Promise<Result<void, Failure[]>> => {
  const optionsResult = getOptions();
  if (!optionsResult.ok) {
    return {ok: false, error: [optionsResult.error]};
  }
  const options = optionsResult.value;

  const workerPool = new WorkerPool(options.numWorkers);

  let cache;
  switch (options.cache) {
    case 'local': {
      // Import dynamically so that we import fewer unnecessary modules.
      const {LocalCache} = await import('./caching/local-cache.js');
      cache = new LocalCache();
      break;
    }
    case 'github': {
      const {GitHubActionsCache} = await import(
        './caching/github-actions-cache.js'
      );
      const cacheResult = GitHubActionsCache.create(logger);
      if (!cacheResult.ok) {
        if (cacheResult.error.reason === 'invalid-usage') {
          return {
            ok: false,
            error: [
              {
                script: options.script,
                type: 'failure',
                reason: 'invalid-usage',
                message: cacheResult.error.message,
              },
            ],
          };
        } else {
          const never: never = cacheResult.error.reason;
          throw new Error(
            `Internal error: unexpected cache result error reason: ${String(
              never
            )}`
          );
        }
      }
      cache = cacheResult.value;
      break;
    }
    case 'none': {
      cache = undefined;
      break;
    }
    default: {
      throw new Error(
        `Unhandled cache: ${unreachable(options.cache) as string}`
      );
    }
  }

  const abort = new Deferred<void>();
  process.on('SIGINT', () => {
    abort.resolve();
  });

  if (options.watch) {
    const {Watcher} = await import('./watcher.js');
    await Watcher.watch(
      options.script,
      logger,
      workerPool,
      cache,
      options.failureMode,
      abort
    );
  } else {
    const analyzer = new Analyzer();
    const {config} = await analyzer.analyze(options.script);
    if (!config.ok) {
      return config;
    }
    const executor = new Executor(
      logger,
      workerPool,
      cache,
      options.failureMode,
      abort
    );
    const result = await executor.execute(config.value);
    if (!result.ok) {
      return result;
    }
  }
  return {ok: true, value: undefined};
};

const result = await run();
if (!result.ok) {
  for (const failure of result.error) {
    logger.log(failure);
  }
  process.exitCode = 1;
}
