/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ScriptReference} from '../config.js';
import type {Fingerprint} from '../fingerprint.js';
import type {AbsoluteEntry} from '../util/glob.js';

/**
 * Saves and restores output files to some cache store (e.g. local disk or
 * remote server).
 */
export interface Cache {
  /**
   * Check for a cache hit for the given script and fingerprint. Don't write it to
   * disk yet, instead return a {@link CacheHit} which can be used to control
   * when writing occurs.
   *
   * @param script The script whose output will be read from the cache.
   * @param fingerprint The string-encoded fingerprint for the script.
   * @return Promise of a {@link CacheHit} if there was an entry in the cache,
   * or undefined if there was not.
   */
  get(
    script: ScriptReference,
    fingerprint: Fingerprint,
  ): Promise<CacheHit | undefined>;

  /**
   * Write the given file paths to the cache if possible, keyed by the given
   * script and fingerprint.
   *
   * It is valid for an implementation to decide not to write to the cache and
   * return false, for example if the contents are too large.
   *
   * @param script The script whose output will be saved to the cache.
   * @param fingerprint The string-encoded fingerprint for the script.
   * @param absoluteFiles The absolute output files to cache.
   * @returns Whether the cache was written.
   */
  set(
    script: ScriptReference,
    fingerprint: Fingerprint,
    absoluteFiles: AbsoluteEntry[],
  ): Promise<boolean>;

  /**
   * Move the entry to the front of an evicting cache's queue without reading it
   * (the local cache updates its mtime). Called when a script was fresh, so
   * nothing was restored; without it, an always-fresh script's entry looks
   * untouched and is eventually evicted. Does nothing if there is no entry.
   *
   * @param script The script whose entry was relied upon.
   * @param fingerprint The string-encoded fingerprint for the script.
   */
  markEntryRecentlyUsed(
    script: ScriptReference,
    fingerprint: Fingerprint,
  ): Promise<void>;

  /**
   * Delete everything this cache has moved aside, this run or a previous one.
   * An evicted entry is a full copy of a script's output, so a script waits
   * only for it to be moved out of the way; the deleting happens here.
   *
   * @param signal Aborts the sweep at the next entry boundary. Safe: whatever
   * is left is picked up by the next run.
   */
  sweepTrash(signal?: AbortSignal): Promise<void>;
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
