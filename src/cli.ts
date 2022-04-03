/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {WireitError} from './error.js';
import {DefaultLogger} from './logging/default-logger.js';
import {Analyzer} from './analyzer.js';
import {Executor} from './executor.js';
import {LocalCache} from './caching/local-cache.js';

const packageDir = process.env.npm_config_local_prefix;
const logger = new DefaultLogger(packageDir ?? process.cwd());

const run = async () => {
  // These "npm_" prefixed environment variables are set by npm. We require that
  // wireit always be launched via an npm script, so if any are missing we
  // assume it was run directly instead of via npm.
  //
  // We need to handle "npx wireit" as a special case, because it sets
  // "npm_lifecycle_event" to "npx". The "npm_execpath" will be either
  // "npm-cli.js" or "npx-cli.js", so we use that to detect this case.
  const name = process.env.npm_lifecycle_event;
  if (
    !packageDir ||
    !name ||
    !process.env.npm_execpath?.endsWith('npm-cli.js')
  ) {
    throw new WireitError({
      type: 'failure',
      reason: 'launched-incorrectly',
      script: {packageDir: packageDir ?? process.cwd()},
    });
  }

  const script = {packageDir, name};

  const abort = new AbortController();
  process.on('SIGINT', () => {
    abort.abort();
  });

  const cache = new LocalCache();

  if (process.argv[2] === 'watch') {
    // Only import the extra modules needed for watch mode if we need them.
    const {Watcher} = await import('./watcher.js');
    await Watcher.watch(script, logger, abort, cache);
  } else {
    const analyzer = new Analyzer();
    const analyzed = await analyzer.analyze(script);
    const executor = new Executor(logger, cache);
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
