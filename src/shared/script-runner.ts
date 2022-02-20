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

/**
 * State which is shared across all scripts.
 */
export class ScriptRunner {
  readonly abort: Promise<unknown>;
  readonly parallelismLimiter: ReservationPool;
  readonly cache?: Cache;
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
    failFast: boolean
  ) {
    this.abort = failFast
      ? Promise.race([this._anyScriptFailed.promise, abort])
      : abort;
    this.cache = cache;
    this.parallelismLimiter = new ReservationPool(parallel);
  }

  async run(ref: ResolvedScriptReference): Promise<ScriptStatus> {
    const key = JSON.stringify([ref.packageJsonPath, ref.scriptName]);
    let promise = this._runCache.get(key);
    if (promise === undefined) {
      promise = (async () => {
        const run = new ScriptRun(this, ref);
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
