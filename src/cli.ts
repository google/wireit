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
      options.failureMode,
      options.agent
    );
    process.on('SIGINT', () => {
      watcher.abort();
    });
    await watcher.watch();
    return {ok: true, value: undefined};
  } else {
    const analyzer = new Analyzer(options.agent);
    const {config} = await analyzer.analyze(options.script, options.extraArgs);
    if (!config.ok) {
      return config;
    }
    if (options.graph) {
      const {Graph} = await import('./graph.js');
      const graph = new Graph(config.value);
      await graph.generate();
      return {ok: true, value: undefined};
    }
    console.log('\n\n\n\n\nOH NO!\n\n\n\n\n\n');
    const executor = new Executor(
      config.value,
      logger,
      workerPool,
      cache,
      options.failureMode,
      undefined,
      false
    );
    process.on('SIGINT', () => {
      executor.abort();
    });
    const {persistentServices, errors} = await executor.execute();
    if (persistentServices.size > 0) {
      for (const service of persistentServices.values()) {
        const result = await service.terminated;
        if (!result.ok) {
          errors.push(result.error);
        }
      }
    }
    logger.printMetrics();
    return errors.length === 0
      ? {ok: true, value: undefined}
      : {ok: false, error: errors};
  }
};

const result = await run();
if (!result.ok) {
  for (const failure of result.error) {
    logger.log(failure);
  }
  process.exitCode = 1;
}
