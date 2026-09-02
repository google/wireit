/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Analyzer} from './analyzer.js';
import {getOptions, Options, packageDir} from './cli-options.js';
import {Result} from './error.js';
import {Failure} from './event.js';
import {Executor} from './executor.js';
import {SimpleLogger} from './logging/simple-logger.js';
import {Console} from './logging/logger.js';
import {unreachable} from './util/unreachable.js';
import {WorkerPool} from './util/worker-pool.js';

import type {Cache} from './caching/cache.js';

/** Below this, a sweep finishes before the user wonders why they're waiting. */
const SWEEP_NOTICE_MS = 1000;

/**
 * Delete the entries this run evicted, plus anything an earlier run left.
 *
 * The notice goes to the console rather than the logger because the default
 * logger drops cache advisories, and this one is only ever seen while a prompt
 * hasn't come back.
 */
const sweepTrash = async (
  cache: Cache | undefined,
  signal: AbortSignal,
): Promise<void> => {
  if (cache === undefined) {
    return;
  }
  const sweep = cache.sweepTrash(signal);
  const notice = setTimeout(() => {
    console.warn(
      '🗑️ Deleting evicted cache entries. ' +
        'Ctrl-C is safe; anything left is deleted on the next run.',
    );
  }, SWEEP_NOTICE_MS);
  try {
    await sweep;
  } finally {
    clearTimeout(notice);
  }
};

const run = async (options: Options): Promise<Result<void, Failure[]>> => {
  using logger = options.logger;
  const workerPool = new WorkerPool(options.numWorkers);
  const sweepAbort = new AbortController();

  let cache;
  switch (options.cache) {
    case 'local': {
      // Import dynamically so that we import fewer unnecessary modules.
      const {LocalCache} = await import('./caching/local-cache.js');
      cache = new LocalCache(options.cacheMaxEntries);
      break;
    }
    case 'github': {
      const {GitHubActionsCache} =
        await import('./caching/github-actions-cache.js');
      const cacheResult = await GitHubActionsCache.create(logger);
      if (cacheResult.ok) {
        cache = cacheResult.value;
      } else {
        cache = undefined;
        console.warn(
          '⚠️ Error initializing GitHub cache. Caching is disabled for this run',
        );
        logger.log({
          script: options.script,
          ...cacheResult.error,
        });
      }
      break;
    }
    case 'none': {
      cache = undefined;
      break;
    }
    default: {
      throw new Error(
        `Unhandled cache: ${unreachable(options.cache) as string}`,
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
      options.agent,
      options.watch,
    );
    process.on('SIGINT', () => {
      watcher.abort();
      sweepAbort.abort();
    });
    process.on('SIGTERM', () => {
      watcher.abort();
      sweepAbort.abort();
    });
    await watcher.watch();
    await sweepTrash(cache, sweepAbort.signal);
    return {ok: true, value: undefined};
  } else {
    const analyzer = new Analyzer(options.agent, logger);
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
      undefined,
      false,
    );
    process.on('SIGINT', () => {
      executor.abort();
      sweepAbort.abort();
    });
    process.on('SIGTERM', () => {
      executor.abort();
      sweepAbort.abort();
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
    await sweepTrash(cache, sweepAbort.signal);
    return errors.length === 0
      ? {ok: true, value: undefined}
      : {ok: false, error: errors};
  }
};

const optionsResult = await getOptions();
if (!optionsResult.ok) {
  // if we can't figure out our options, we can't figure out what logger
  // we should use here, so just use the default logger.
  const console = new Console(process.stderr, process.stderr);
  const logger = new SimpleLogger(packageDir ?? process.cwd(), console);
  logger.log(optionsResult.error);
  process.exit(1);
}

const options = optionsResult.value;
const result = await run(options);
if (!result.ok) {
  for (const failure of result.error) {
    options.logger.log(failure);
  }
  process.exitCode = 1;
}
