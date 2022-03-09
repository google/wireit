/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {ReservationPool} from '../shared/reservation-pool.js';
import {readRawConfig} from './read-raw-config.js';
import {Deferred} from '../shared/deferred.js';
import {ScriptRun} from './script-run.js';

import type {Cache} from '../shared/cache.js';
import type {
  ResolvedScriptReference,
  RawPackageConfig,
} from '../types/config.js';
import type {ScriptStatus} from '../types/cache.js';
import {Logger} from './logger.js';
import {KnownError} from './known-error.js';

/**
 * State which is shared across all scripts.
 */
export class ScriptRunner {
  readonly abort: Promise<unknown>;
  readonly parallelismLimiter: ReservationPool;
  readonly cache?: Cache;
  readonly logger?: Logger;
  private readonly _runCache = new Map<string, Promise<ScriptStatus>>();
  private readonly _packageConfigCache = new Map<
    string,
    Promise<RawPackageConfig>
  >();
  private readonly _anyScriptFailed = new Deferred<void>();

  constructor(
    abort: Promise<unknown>,
    cache: Cache | undefined,
    parallel: number,
    failFast: boolean,
    logger: Logger | undefined
  ) {
    this.abort = failFast
      ? Promise.race([this._anyScriptFailed.promise, abort])
      : abort;
    this.cache = cache;
    this.parallelismLimiter = new ReservationPool(parallel);
    this.logger = logger;
  }

  async run(
    ref: ResolvedScriptReference,
    ancestry: ReadonlyArray<ResolvedScriptReference> = []
  ): Promise<ScriptStatus> {
    this._checkForCycles(ref, ancestry);
    const key = JSON.stringify([ref.packageJsonPath, ref.scriptName]);
    let promise = this._runCache.get(key);
    if (promise === undefined) {
      promise = (async () => {
        const run = new ScriptRun(this, ref, ancestry);
        try {
          return await run.resolve();
        } catch (err) {
          this._anyScriptFailed.resolve();
          throw err;
        }
      })();
      this._runCache.set(key, promise);
    }
    return promise;
  }

  private _checkForCycles(
    ref: ResolvedScriptReference,
    ancestry: ReadonlyArray<ResolvedScriptReference>
  ): void {
    for (const ancestor of ancestry) {
      if (
        ancestor.packageJsonPath === ref.packageJsonPath &&
        ancestor.scriptName === ref.scriptName
      ) {
        this.logger?.log({script: ref, type: 'failure', reason: 'cycle'});
        throw new KnownError(
          'cycle',
          `Cycle detected: ${[...ancestry, ref]
            .map((ref) => `${ref.packageJsonPath}:${ref.scriptName}`)
            .join(' -> ')}`
        );
      }
    }
  }

  async getRawPackageConfig(
    packageJsonPath: string
  ): Promise<RawPackageConfig> {
    let promise = this._packageConfigCache.get(packageJsonPath);
    if (promise === undefined) {
      promise = readRawConfig(packageJsonPath);
      this._packageConfigCache.set(packageJsonPath, promise);
    }
    return promise;
  }
}
