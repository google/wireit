/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'os';
import {WireitError} from './error.js';
import {DefaultLogger} from './logging/default-logger.js';
import {Analyzer} from './analyzer.js';
import {Executor} from './executor.js';
import {WorkerPool} from './util/worker-pool.js';
import {unreachable} from './util/unreachable.js';

import type {ScriptReference} from './script.js';

const packageDir = process.env.npm_config_local_prefix;
const logger = new DefaultLogger(packageDir ?? process.cwd());

interface Options {
  script: ScriptReference;
  watch: boolean;
  numWorkers: number;
  cache: 'local' | 'github' | 'none';
}

const getOptions = (): Options => {
  // These "npm_" prefixed environment variables are set by npm. We require that
  // wireit always be launched via an npm script, so if any are missing we
  // assume it was run directly instead of via npm.
  //
  // We need to handle "npx wireit" as a special case, because it sets
  // "npm_lifecycle_event" to "npx". The "npm_execpath" will be either
  // "npm-cli.js" or "npx-cli.js", so we use that to detect this case.
  if (!packageDir) {
    const npmMajorVersion =
      process.env.npm_config_user_agent?.match(/npm\/(\d+)/)?.[1];
    const minimumMajorNpmVersion = 8;
    if (
      npmMajorVersion != null &&
      Number(npmMajorVersion) < minimumMajorNpmVersion
    ) {
      throw new WireitError({
        type: 'failure',
        reason: 'old-npm-version',
        minNpmVersion: `${minimumMajorNpmVersion}`,
        script: {packageDir: process.cwd()},
        detail: `Env variable npm_config_local_prefix was not set.`,
      });
    }
  }
  const name = process.env.npm_lifecycle_event;
  const execPathCorrect = process.env.npm_execpath?.endsWith('npm-cli.js');
  if (!packageDir || !name || !execPathCorrect) {
    throw new WireitError({
      type: 'failure',
      reason: 'launched-incorrectly',
      script: {packageDir: packageDir ?? process.cwd()},
    });
  }
  const script = {packageDir, name};

  const numWorkers = (() => {
    const workerString = process.env['WIREIT_PARALLEL'] ?? '';
    // Many scripts will be IO blocked rather than CPU blocked, so running
    // multiple scripts per CPU will help keep things moving.
    const defaultValue = os.cpus().length * 4;
    if (workerString.match(/^infinity$/i)) {
      return Infinity;
    }
    if (workerString == null || workerString === '') {
      return defaultValue;
    }
    const parsedInt = parseInt(workerString, 10);
    if (Number.isNaN(parsedInt) || parsedInt <= 0) {
      throw new WireitError({
        reason: 'invalid-usage',
        message:
          `Expected the WIREIT_PARALLEL env variable to be ` +
          `a positive integer, got ${JSON.stringify(workerString)}`,
        script,
        type: 'failure',
      });
    }
    return parsedInt;
  })();

  const cache = (() => {
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
      return ci ? 'none' : 'local';
    }
    if (str === 'local' || str === 'github' || str === 'none') {
      return str;
    }
    throw new WireitError({
      reason: 'invalid-usage',
      message:
        `Expected the WIREIT_CACHE env variable to be ` +
        `"local", "github", or "none", got ${JSON.stringify(str)}`,
      script,
      type: 'failure',
    });
  })();

  return {
    script,
    watch: process.argv[2] === 'watch',
    numWorkers,
    cache,
  };
};

const run = async () => {
  const options = getOptions();

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
      const {GitHubActionsCache, GitHubActionsCacheError} = await import(
        './caching/github-actions-cache.js'
      );
      try {
        cache = new GitHubActionsCache(logger);
      } catch (error) {
        if (
          error instanceof GitHubActionsCacheError &&
          error.reason === 'invalid-usage'
        ) {
          throw new WireitError({
            script: options.script,
            type: 'failure',
            reason: 'invalid-usage',
            message: error.message,
          });
        }
        throw error;
      }
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

  const abort = new AbortController();
  process.on('SIGINT', () => {
    abort.abort();
  });

  if (options.watch) {
    const {Watcher} = await import('./watcher.js');
    await Watcher.watch(options.script, logger, workerPool, cache, abort);
  } else {
    const analyzer = new Analyzer();
    const analyzed = await analyzer.analyze(options.script);
    const executor = new Executor(logger, workerPool, cache);
    await executor.execute(analyzed);
  }
};

try {
  await run();
} catch (error) {
  const errors = error instanceof AggregateError ? error.errors : [error];
  for (const e of errors) {
    if (e instanceof WireitError) {
      logger.log(e.event);
    } else {
      // Only print a stack trace if we get an unexpected error.
      console.error(`Unexpected error: ${(e as Error).toString()}}`);
      console.error((e as Error).stack);
    }
  }
  process.exitCode = 1;
}
