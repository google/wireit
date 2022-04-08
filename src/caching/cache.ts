/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ScriptStateString, ScriptReference} from '../script.js';

/**
 * Saves and restores output files to some cache store (e.g. local disk or
 * remote server).
 */
export interface Cache {
  /**
   * Check for a cache hit for the given script and cache key. Don't write it to
   * disk yet, instead return a {@link CacheHit} which can be used to control
   * when writing occurs.
   *
   * @param script The script whose output will be read from the cache.
   * @param cacheKey The string-encoded cache key for the script.
   * @return Promise of a {@link CacheHit} if there was an entry in the cache,
   * or undefined if there was not.
   */
  get(
    script: ScriptReference,
    cacheKey: ScriptStateString
  ): Promise<CacheHit | undefined>;

  /**
   * Write the given file paths to the cache, keyed by the given script and
   * cache key.
   *
   * @param script The script whose output will be saved to the cache.
   * @param cacheKey The string-encoded cache key for the script.
   * @param relativeFilePaths The package-relative output file paths to cache
   * (concrete paths, not glob patterns).
   */
  set(
    script: ScriptReference,
    cacheKey: ScriptStateString,
    relativeFilePaths: string[]
  ): Promise<void>;
}

/**
 * The result of {@link Cache.get}.
 *
 * Note the reason {@link Cache.get} reteurns this class instead of immediately
 * applying writing the cached output is so that the {@link Executor} can
 * control the timing of when cached output is written.
 */
export interface CacheHit {
  /**
   * Write the cached files to disk.
   *
   * It is assumed that any existing stale output has already been cleaned
   * before this method is called.
   */
  apply(): Promise<void>;
}
