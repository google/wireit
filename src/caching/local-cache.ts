/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from '../util/fs.js';
import * as pathlib from 'path';
import {createHash} from 'crypto';
import {getScriptDataDir} from '../util/script-data-dir.js';
import {copyEntries} from '../util/copy.js';
import {glob} from '../util/glob.js';

import type {Cache, CacheHit} from './cache.js';
import type {ScriptReference} from '../config.js';
import type {Fingerprint} from '../fingerprint.js';
import type {AbsoluteEntry} from '../util/glob.js';

/**
 * Caches script output to each package's
 * ".wireit/<script-name-hex>/cache/<cache-key-sha256-hex>" folder, keeping only
 * the {@link maxEntries} least recently read or written entries per script.
 *
 * Eviction needs no lock of its own. It only touches the calling script's own
 * cache folder, and StandardScriptExecution#acquireSystemLockIfNeeded already
 * holds that script's lock, except when "output" is empty, in which case the
 * entries are empty directories.
 */
export class LocalCache implements Cache {
  readonly #maxEntries: number;

  /** @param maxEntries Entries to retain per script, or Infinity for all. */
  constructor(maxEntries: number) {
    this.#maxEntries = maxEntries;
  }

  async get(
    script: ScriptReference,
    fingerprint: Fingerprint,
  ): Promise<CacheHit | undefined> {
    const cacheDir = this.#getCacheDir(script, fingerprint);
    try {
      await fs.access(cacheDir);
    } catch (error) {
      if ((error as Error & {code?: string}).code === 'ENOENT') {
        return;
      }
      throw error;
    }
    // Recency lives in the mtime, so there is no index file to maintain. atime
    // won't do, because filesystems are commonly mounted noatime or relatime.
    const now = new Date();
    try {
      await fs.utimes(cacheDir, now, now);
    } catch {
      // A directory we can't stamp (read-only mount, foreign owner) must still
      // produce a hit. It just ages as though it had only ever been written.
    }
    return new LocalCacheHit(cacheDir, script.packageDir);
  }

  async set(
    script: ScriptReference,
    fingerprint: Fingerprint,
    absoluteFiles: AbsoluteEntry[],
  ): Promise<boolean> {
    const absCacheDir = this.#getCacheDir(script, fingerprint);
    // Note fs.mkdir returns the first created directory, or undefined if no
    // directory was created.
    const existed =
      (await fs.mkdir(absCacheDir, {recursive: true})) === undefined;
    if (existed) {
      // This is an unexpected error because the Executor should already have
      // checked for an existing cache hit.
      throw new Error(`Did not expect ${absCacheDir} to already exist.`);
    }
    await copyEntries(absoluteFiles, script.packageDir, absCacheDir);
    await this.#evictLeastRecentlyUsedEntries(script);
    return true;
  }

  /**
   * Housekeeping, so failures are swallowed: the entry we just wrote is still
   * valid, the folder is only larger than asked for.
   */
  async #evictLeastRecentlyUsedEntries(script: ScriptReference): Promise<void> {
    if (this.#maxEntries === Infinity) {
      return;
    }
    try {
      const cacheDir = this.#getScriptCacheDir(script);
      const entries = await fs.readdir(cacheDir, {withFileTypes: true});
      if (entries.length <= this.#maxEntries) {
        return;
      }
      // lstat, so a broken symlink in the folder gets evicted rather than
      // throwing on every future eviction.
      const byRecency = await Promise.all(
        entries.map(async (entry) => {
          const path = pathlib.join(cacheDir, entry.name);
          return {path, mtimeMs: (await fs.lstat(path)).mtimeMs};
        }),
      );
      byRecency.sort((a, b) => a.mtimeMs - b.mtimeMs);
      const doomed = byRecency.slice(0, byRecency.length - this.#maxEntries);
      await Promise.all(
        doomed.map(({path}) => fs.rm(path, {recursive: true, force: true})),
      );
    } catch {
      // See above.
    }
  }

  #getScriptCacheDir(script: ScriptReference): string {
    return pathlib.join(getScriptDataDir(script), 'cache');
  }

  #getCacheDir(script: ScriptReference, fingerprint: Fingerprint): string {
    return pathlib.join(
      this.#getScriptCacheDir(script),
      createHash('sha256').update(fingerprint.string).digest('hex'),
    );
  }
}

class LocalCacheHit implements CacheHit {
  /**
   * The folder where the cached output is stored. Assumed to exist.
   */
  readonly #source: string;

  /**
   * The folder where the cached output should be written when {@link apply} is
   * called.
   */
  readonly #destination: string;

  constructor(source: string, destination: string) {
    this.#source = source;
    this.#destination = destination;
  }

  async apply(): Promise<void> {
    const entries = await glob(['**'], {
      cwd: this.#source,
      followSymlinks: false,
      includeDirectories: true,
      expandDirectories: true,
      // Shouldn't ever happen, but would be really weird.
      throwIfOutsideCwd: true,
    });
    await copyEntries(entries, this.#source, this.#destination);
  }
}
