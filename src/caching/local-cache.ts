/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from '../util/fs.js';
import * as pathlib from 'path';
import {createHash, randomBytes} from 'crypto';
import {getPackageDataDir, getScriptDataDir} from '../util/script-data-dir.js';
import {copyEntries} from '../util/copy.js';
import {glob} from '../util/glob.js';

import type {Cache, CacheHit} from './cache.js';
import type {ScriptReference} from '../config.js';
import type {Fingerprint} from '../fingerprint.js';
import type {AbsoluteEntry} from '../util/glob.js';

/**
 * Caches script output to each package's
 * ".wireit/<script-name-hex>/cache/<cache-key-sha256-hex>" folder, keeping only
 * the {@link maxEntries} most recently read or written entries per script.
 * Evicted entries move to the package's ".wireit/trash", which
 * {@link sweepTrash} empties, so a script never waits on a large delete.
 *
 * Eviction needs no lock of its own: it touches only the calling script's cache
 * folder, and StandardScriptExecution#acquireSystemLockIfNeeded already holds
 * that script's lock, except for an empty "output", where the entries are empty
 * directories. Sweeping is deliberately unlocked, so any number of Wireit
 * processes can empty the same trash at once and a vanished entry is expected.
 */
export class LocalCache implements Cache {
  readonly #maxEntries: number;

  /** Packages used this run, whose trash {@link sweepTrash} empties. */
  readonly #packageDirs = new Set<string>();

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
    await this.markEntryRecentlyUsed(script, fingerprint);
    return new LocalCacheHit(cacheDir, script.packageDir);
  }

  async markEntryRecentlyUsed(
    script: ScriptReference,
    fingerprint: Fingerprint,
  ): Promise<void> {
    this.#packageDirs.add(script.packageDir);
    // Recency lives in the mtime, so there is no index file to maintain. atime
    // won't do, because filesystems are commonly mounted noatime or relatime.
    const now = new Date();
    try {
      await fs.utimes(this.#getCacheDir(script, fingerprint), now, now);
    } catch {
      // No entry, or one we can't stamp (read-only mount, foreign owner). A hit
      // is still a hit; the entry just ages as though only ever written.
    }
  }

  async set(
    script: ScriptReference,
    fingerprint: Fingerprint,
    absoluteFiles: AbsoluteEntry[],
  ): Promise<boolean> {
    this.#packageDirs.add(script.packageDir);
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
    await this.#evictAllButMostRecentlyUsed(
      script,
      pathlib.basename(absCacheDir),
    );
    return true;
  }

  async sweepTrash(signal?: AbortSignal): Promise<void> {
    await Promise.all(
      [...this.#packageDirs].map((packageDir) =>
        this.#sweepPackageTrash(packageDir, signal),
      ),
    );
  }

  /**
   * Housekeeping, so failures are swallowed: the entry just written is still
   * valid, the folder is only larger than asked for.
   *
   * @param justWrittenName Never evicted. mtime resolution is coarse on some
   * filesystems, so it can tie with an older entry and lose the sort.
   */
  async #evictAllButMostRecentlyUsed(
    script: ScriptReference,
    justWrittenName: string,
  ): Promise<void> {
    if (this.#maxEntries === Infinity) {
      return;
    }
    try {
      const cacheDir = this.#getScriptCacheDir(script);
      const entries = await fs.readdir(cacheDir, {withFileTypes: true});
      if (entries.length <= this.#maxEntries) {
        return;
      }
      const candidates = entries
        .filter((entry) => entry.name !== justWrittenName)
        .map((entry) => pathlib.join(cacheDir, entry.name));
      // lstat, so a broken symlink in the folder gets evicted rather than
      // throwing on every future eviction.
      const byRecency = await Promise.all(
        candidates.map(async (path) => ({
          path,
          mtimeMs: (await fs.lstat(path)).mtimeMs,
        })),
      );
      byRecency.sort((a, b) => a.mtimeMs - b.mtimeMs);
      const doomed = byRecency.slice(0, entries.length - this.#maxEntries);
      // allSettled, so one entry we can't move (EPERM on Windows, while
      // something holds it open) doesn't block evicting the rest.
      await Promise.allSettled(
        doomed.map(({path}) => this.#moveToTrash(script.packageDir, path)),
      );
    } catch {
      // See above.
    }
  }

  async #moveToTrash(packageDir: string, path: string): Promise<void> {
    const trashDir = this.#getTrashDir(packageDir);
    await fs.mkdir(trashDir, {recursive: true});
    // Random, not the entry's own name: the same entry can be evicted, written
    // and evicted again before a sweep reaches it. Short, because every file in
    // the entry is renamed onto this path.
    const name = randomBytes(8).toString('hex');
    await fs.rename(path, pathlib.join(trashDir, name));
  }

  async #sweepPackageTrash(
    packageDir: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const trashDir = this.#getTrashDir(packageDir);
    let entries;
    try {
      entries = await fs.readdir(trashDir, {withFileTypes: true});
    } catch {
      // ENOENT: nothing evicted, or another process already swept it away.
      return;
    }
    for (const entry of entries) {
      if (signal?.aborted) {
        return;
      }
      try {
        // force, because another process may be sweeping the same folder.
        await fs.rm(pathlib.join(trashDir, entry.name), {
          recursive: true,
          force: true,
        });
      } catch {
        // Undeletable right now (EBUSY on Windows). The next run tries again;
        // a sweep must never fail a build.
      }
    }
    try {
      await fs.rmdir(trashDir);
    } catch {
      // Not empty: aborted, or another process is still evicting into it.
    }
  }

  /** Safe beside the per-script dirs: a hex script name can't spell "trash". */
  #getTrashDir(packageDir: string): string {
    return pathlib.join(getPackageDataDir(packageDir), 'trash');
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
