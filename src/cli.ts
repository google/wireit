/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Result} from './error.js';
import {Analyzer} from './analyzer.js';
import {Executor} from './executor.js';
import {WorkerPool} from './util/worker-pool.js';
import {unreachable} from './util/unreachable.js';
import {Failure} from './event.js';
import {logger, getOptions} from './cli-options.js';

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

  if (options.watch) {
    const {Watcher} = await import('./watcher.js');
    const watcher = new Watcher(
      options.script,
      options.extraArgs,
      logger,
      workerPool,
      cache,
      options.failureMode
    );
    process.on('SIGINT', () => {
      watcher.abort();
    });
    await watcher.watch();
  } else {
    const analyzer = new Analyzer();
    const {config} = await analyzer.analyze(options.script, options.extraArgs);
    if (!config.ok) {
      return config;
    }
    const executor = new Executor(
      config.value,
      logger,
      workerPool,
      cache,
      options.failureMode,
      undefined
    );
    process.on('SIGINT', () => {
      executor.abort();
    });
    const result = await executor.execute();
    if (!result.ok) {
      return result;
    }
    const persistentServices = result.value;
    if (persistentServices.size > 0) {
      const failures: Failure[] = [];
      for (const service of persistentServices.values()) {
        const result = await service.terminated;
        if (!result.ok) {
          failures.push(result.error);
        }
      }
      if (failures.length > 0) {
        return {
          ok: false,
          error: failures,
        };
      }
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
