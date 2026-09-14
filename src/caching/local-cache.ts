/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from '../util/fs.js';
import * as pathlib from 'path';
import {randomBytes} from 'crypto';
import {getPackageDataDir} from '../util/script-data-dir.js';
import {copyEntries} from '../util/copy.js';
import {glob} from '../util/glob.js';
import {resolveCachePackageDir} from '../util/cache-root.js';
import {hashPortableFingerprint} from '../util/portable-fingerprint.js';

import type {Cache, CacheHit} from './cache.js';
import type {ScriptReference} from '../config.js';
import type {Fingerprint} from '../fingerprint.js';
import type {AbsoluteEntry} from '../util/glob.js';

/**
 * The most entries that one cache write evicts. A cache folder can hold far
 * more entries than the limit, such as one filled before the limit feature was
 * implemented. Evicting them all at once would make that run wait at exit until
 * they are deleted, which can take minutes when "output" is large. With two per
 * write, such a folder shrinks by one entry per write.
 */
const MAX_EVICTIONS_PER_WRITE = 2;

/**
 * The most file system calls a background sweep can have in flight at once,
 * across all the packages it sweeps. This matches Node's default of 4 threads
 * for file system calls, so the next watch mode iteration's calls wait behind
 * at most 4 deletions. Without this limit, a sweep used the whole open file
 * budget of 200 calls, and on a slow disk the next iteration waited for most of
 * the sweep.
 */
const BACKGROUND_SWEEP_MAX_CONCURRENT = 4;

/**
 * Wireit reminds the user when a script's cache folder holds more than this
 * many times the limit. Such a folder takes many writes to shrink, one entry
 * per write, and the user may rather free the space at once.
 */
const REMIND_OVER_LIMIT_FACTOR = 2;

/** How often to remind the user about the same package. */
const REMIND_OVER_LIMIT_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Caches script output to each package's
 * ".wireit/<script-name-hex>/cache/<cache-key-sha256-hex>" folder, keeping only
 * the {@link maxEntries} most recently read or written entries per script. A
 * folder over the limit shrinks by one entry per write, because each write adds
 * an entry and evicts up to {@link MAX_EVICTIONS_PER_WRITE}. Evicted entries
 * move to the package's ".wireit/trash", which {@link sweepTrash} empties.
 *
 * Eviction needs no lock of its own: it touches only the calling script's cache
 * folder, and StandardScriptExecution#acquireSystemLockIfNeeded already holds
 * that script's lock, except for an empty "output", where the entries are empty
 * directories. Sweeping is deliberately unlocked, so any number of Wireit
 * processes can empty the same trash at once and a vanished entry is expected.
 */
export class LocalCache implements Cache {
  readonly #maxEntries: number;
  readonly #cacheDir: string | undefined;

  /** Cache package dirs used this run, whose trash {@link sweepTrash} empties. */
  readonly #packageDirs = new Set<string>();

  /** Messages for the user, which the next {@link sweepTrash} returns. */
  #messages: string[] = [];

  /**
   * Packages that {@link #remindOverLimit} has seen this run, so that several
   * scripts over the limit in one package give one reminder.
   */
  readonly #remindedPackages = new Set<string>();

  /**
   * @param maxEntries Entries to retain per script, or Infinity for all.
   * @param cacheDir Optional WIREIT_CACHE_DIR. Linked git worktrees still
   * share via the main worktree when this is unset.
   */
  constructor(maxEntries: number, cacheDir?: string) {
    this.#maxEntries = maxEntries;
    this.#cacheDir = cacheDir;
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
    this.#packageDirs.add(this.#cachePackageDir(script));
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
    this.#packageDirs.add(this.#cachePackageDir(script));
    const absCacheDir = this.#getCacheDir(script, fingerprint);
    const tmpDir = pathlib.join(
      pathlib.dirname(absCacheDir),
      '..',
      `.tmp-${randomBytes(8).toString('hex')}`,
    );
    await fs.mkdir(tmpDir, {recursive: true});
    try {
      await copyEntries(absoluteFiles, script.packageDir, tmpDir);
      await fs.mkdir(pathlib.dirname(absCacheDir), {recursive: true});
      await fs.rename(tmpDir, absCacheDir);
    } catch (error) {
      await fs.rm(tmpDir, {recursive: true, force: true});
      const code = (error as {code?: string}).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM') {
        try {
          await fs.access(absCacheDir);
          return true;
        } catch {
          throw error;
        }
      }
      throw error;
    }
    await this.#evictLeastRecentlyUsed(script, pathlib.basename(absCacheDir));
    return true;
  }

  async sweepTrash({
    signal,
    background = false,
  }: {signal?: AbortSignal; background?: boolean} = {}): Promise<string[]> {
    // One Semaphore for the whole sweep. Packages are swept in parallel, so a
    // Semaphore per package would allow that many calls per package.
    const slots = background
      ? new fs.Semaphore(BACKGROUND_SWEEP_MAX_CONCURRENT)
      : undefined;
    const messages = this.#messages;
    this.#messages = [];
    const sweepMessages = await Promise.all(
      [...this.#packageDirs].map((packageDir) =>
        this.#sweepPackageTrash(packageDir, {signal, slots}),
      ),
    );
    return [...messages, ...sweepMessages.flat()];
  }

  /**
   * Housekeeping, so failures are swallowed: the entry just written is still
   * valid, the folder is only larger than asked for.
   *
   * @param justWrittenName Never evicted. mtime resolution is coarse on some
   * filesystems, so it can tie with an older entry and lose the sort.
   */
  async #evictLeastRecentlyUsed(
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
      const doomed = byRecency.slice(
        0,
        Math.min(entries.length - this.#maxEntries, MAX_EVICTIONS_PER_WRITE),
      );
      // allSettled, so one entry we can't move (EPERM on Windows, while
      // something holds it open) doesn't block evicting the rest.
      await Promise.allSettled(
        doomed.map(({path}) =>
          this.#moveToTrash(this.#cachePackageDir(script), path),
        ),
      );
      const numLeft = entries.length - doomed.length;
      if (numLeft > REMIND_OVER_LIMIT_FACTOR * this.#maxEntries) {
        await this.#remindOverLimit(script.packageDir);
      }
    } catch {
      // See above.
    }
  }

  /**
   * Tells the user that a package's cache is far over its limit, at most once
   * per {@link REMIND_OVER_LIMIT_EVERY_MS}. The modification time of a file in
   * the package's ".wireit" folder records when Wireit last did.
   */
  async #remindOverLimit(packageDir: string): Promise<void> {
    if (this.#remindedPackages.has(packageDir)) {
      return;
    }
    this.#remindedPackages.add(packageDir);
    const dataDir = getPackageDataDir(packageDir);
    const lastReminder = pathlib.join(dataDir, 'over-limit-reminder');
    try {
      const {mtimeMs} = await fs.stat(lastReminder);
      if (Date.now() - mtimeMs < REMIND_OVER_LIMIT_EVERY_MS) {
        return;
      }
    } catch {
      // The file doesn't exist, so Wireit hasn't reminded the user yet.
    }
    await fs.writeFile(lastReminder, '', 'utf8');
    this.#messages.push(
      `ℹ️ The Wireit cache in ${packageDir} is far over its limit, and ` +
        `shrinks by one entry per cache write. To free the space now, ` +
        `delete ${pathlib.join(dataDir, '*', 'cache')}.`,
    );
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
    options: {signal?: AbortSignal; slots?: fs.Semaphore},
  ): Promise<string[]> {
    const trashDir = this.#getTrashDir(packageDir);
    let entries;
    try {
      // A slot here and for the rmdir below too, not only in rmTree, because
      // every package used this run lists its trash at once.
      using _slot = await options.slots?.reserve();
      entries = await fs.readdir(trashDir, {withFileTypes: true});
    } catch {
      // ENOENT: nothing evicted, or another process already swept it away.
      return [];
    }
    const messages: string[] = [];
    for (const entry of entries) {
      if (options.signal?.aborted) {
        return messages;
      }
      const path = pathlib.join(trashDir, entry.name);
      try {
        // rmTree, not fs.rm, so that an abort stops part way through an entry.
        await fs.rmTree(path, options);
      } catch (error) {
        if (options.signal?.aborted) {
          return messages;
        }
        // Such as EBUSY on Windows, while another program has a file open, or
        // EACCES on Linux and macOS, when a folder in the entry is read-only.
        // A sweep must never fail a build, and the next run tries again, but
        // the user should know that the space isn't being freed.
        messages.push(
          `⚠️ Could not delete ${path}, a cache entry that Wireit evicted: ` +
            `${(error as Error).message}. Wireit will try again on its next ` +
            `run. If this keeps happening, ` +
            (mayBeOpenElsewhere(error)
              ? `close any program that might be using it, or delete it ` +
                `yourself.`
              : `delete it yourself.`),
        );
      }
    }
    try {
      using _slot = await options.slots?.reserve();
      await fs.rmdir(trashDir);
    } catch {
      // Not empty: aborted, a failed entry, or another process is still
      // evicting into it.
    }
    return messages;
  }

  /** Safe beside the per-script dirs: a hex script name can't spell "trash". */
  #getTrashDir(packageDir: string): string {
    return pathlib.join(getPackageDataDir(packageDir), 'trash');
  }

  #cachePackageDir(script: ScriptReference): string {
    return resolveCachePackageDir(script.packageDir, this.#cacheDir);
  }

  #getScriptCacheDir(script: ScriptReference): string {
    return pathlib.join(
      getPackageDataDir(this.#cachePackageDir(script)),
      Buffer.from(script.name).toString('hex'),
      'cache',
    );
  }

  #getCacheDir(script: ScriptReference, fingerprint: Fingerprint): string {
    return pathlib.join(
      this.#getScriptCacheDir(script),
      hashPortableFingerprint(fingerprint, script.packageDir),
    );
  }
}

/**
 * Whether a delete may have failed because another program has the file open.
 * Windows refuses to delete an open file, with EBUSY, or with EPERM for some
 * kinds of open, such as a running program. Elsewhere EPERM is a permissions
 * error, which closing programs won't fix.
 */
const mayBeOpenElsewhere = (error: unknown) => {
  const code = (error as {code?: string}).code;
  return code === 'EBUSY' || (code === 'EPERM' && process.platform === 'win32');
};

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
