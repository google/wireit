/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {WireitError} from './error.js';
import {DefaultLogger} from './logging/default-logger.js';
import {Analyzer} from './analyzer.js';

const run = async () => {
  // These "npm_" prefixed environment variables are set by npm. We require that
  // wireit always be launched via an npm script, so if any are missing we
  // assume it was run directly instead of via npm.
  //
  // We need to handle "npx wireit" as a special case, because it sets
  // "npm_lifecycle_event" to "npx". The "npm_execpath" will be either
  // "npm-cli.js" or "npx-cli.js", so we use that to detect this case.
  const packageDir = process.env.npm_config_local_prefix;
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

  const analyzer = new Analyzer();
  await analyzer.analyze({packageDir, name});
};

const logger = new DefaultLogger();
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
