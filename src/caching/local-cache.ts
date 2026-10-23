/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from '../util/fs.js';
import * as pathlib from 'path';
import {randomBytes} from 'crypto';
import lockfile from 'proper-lockfile';
import {getPackageDataDir, getScriptDataDir} from '../util/script-data-dir.js';
import {copyEntries} from '../util/copy.js';
import {glob} from '../util/glob.js';
import {resolveCachePackageDir} from '../util/cache-root.js';

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
 * The minimum age of a leftover temp folder before Wireit trashes it. A
 * younger folder may belong to a save that is still running in another
 * worktree.
 */
const TEMP_LEFTOVER_MIN_AGE_MS = 60 * 60 * 1000;

/** The name of the lock that an eviction takes in an entry's lock folder. */
const EVICT_LOCK = 'evict';

/**
 * The prefix of each restore's lock name. The rest of the name is random. So
 * two restores never take the same lock.
 */
const RESTORE_LOCK_PREFIX = 'restore-';

const ENTRY_LOCK_OPTIONS = {
  // A crashed holder stops updating mtime, so the lock becomes acquirable.
  // Same values as the script lock.
  stale: 10_000,
  update: 2000,
  retries: 0,
  // Don't resolve the lock's real path. By default proper-lockfile resolves
  // it, and that needs a file at the path. Wireit would then have to create
  // an empty file for each entry and leave it behind. With this option off,
  // no file is needed. The lock is a ".lock" folder, and releasing the lock
  // deletes the folder.
  realpath: false,
};

/**
 * Caches script output to each package's
 * ".wireit/<script-name-hex>/cache/<cache-key-sha256-hex>" folder, keeping only
 * the {@link maxEntries} most recently read or written entries per script. A
 * folder over the limit shrinks by one entry per write, because each write adds
 * an entry and evicts up to {@link MAX_EVICTIONS_PER_WRITE}. Evicted entries
 * move to the package's ".wireit/trash", which {@link sweepTrash} empties.
 *
 * Entries are copied into the script's "temp" folder and then renamed into
 * place, so a killed Wireit can't leave a partial entry.
 *
 * A linked worktree with WIREIT_CACHE_WORKTREES stores its cache in the main
 * worktree's cache folder. It does this even when the main worktree does not
 * set the flag. The worktrees share the folder, but each worktree has its own
 * script lock. So every cache follows two rules, with or without the flag:
 *
 * - Each entry has locks in a "cache-locks" folder next to the cache. A
 *   restore holds a lock while it copies. Eviction skips an entry while a
 *   restore holds a lock on it. So eviction never deletes an entry during a
 *   restore.
 * - Wireit trashes a leftover in the script's "temp" folder only when the
 *   leftover is over an hour old. A newer leftover may be a save that is still
 *   running in another worktree.
 *
 * Eviction needs no other lock. It only changes the calling script's cache
 * folder. Within one worktree, the script's lock already covers that folder.
 * StandardScriptExecution#acquireSystemLockIfNeeded takes that lock. The one
 * exception is an empty "output", whose entries are empty directories.
 * Sweeping takes no lock on purpose. Any number of Wireit processes can empty
 * the same trash at once. So an entry can disappear during a sweep.
 */
export class LocalCache implements Cache {
  readonly #maxEntries: number;
  readonly #shareWorktrees: boolean;

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
   * Maps each package folder to the package that holds its cache. Finding
   * that package reads several git files, so the cache finds it once per run.
   */
  readonly #cachePackageDirs = new Map<string, Promise<string>>();

  /**
   * @param maxEntries Entries to retain per script, or Infinity for all.
   * @param options When `shareWorktrees` is true, linked git worktrees write
   * cache into the main worktree's matching `.wireit`.
   */
  constructor(maxEntries: number, options?: {shareWorktrees?: boolean}) {
    this.#maxEntries = maxEntries;
    this.#shareWorktrees = options?.shareWorktrees === true;
  }

  async get(
    script: ScriptReference,
    fingerprint: Fingerprint,
  ): Promise<CacheHit | undefined> {
    const cachePackageDir = await this.#cachePackageDir(script);
    const entryName = fingerprint.localCacheEntryName(this.#shareWorktrees);
    const cacheDir = pathlib.join(
      this.#getScriptCacheDir(cachePackageDir, script),
      entryName,
    );
    // A miss takes no lock.
    if (!(await exists(cacheDir))) {
      return undefined;
    }
    // Hold a restore lock during the restore. Then eviction in another
    // worktree cannot delete the entry while it is being copied. Check that
    // the entry still exists after taking the lock. It may have been evicted
    // while this run waited.
    let release: () => Promise<void>;
    try {
      release = await this.#lockForRestore(
        this.#getEntryLockDir(cachePackageDir, script, entryName),
      );
    } catch (error) {
      if (!cannotWrite(error)) {
        throw error;
      }
      // The cache folder is read-only, such as on a read-only mount. Restore
      // without a lock. No run can evict from a folder it cannot write.
      release = async () => {};
    }
    try {
      try {
        await fs.access(cacheDir);
      } catch (error) {
        if ((error as Error & {code?: string}).code === 'ENOENT') {
          await release().catch(() => {});
          return;
        }
        throw error;
      }
      this.#packageDirs.add(cachePackageDir);
      const now = new Date();
      try {
        await fs.utimes(cacheDir, now, now);
      } catch {
        // No entry, or one we can't stamp (read-only mount, foreign owner).
        // A hit is still a hit; the entry just ages as though only ever
        // written.
      }
      return new LocalCacheHit(cacheDir, script.packageDir, release);
    } catch (error) {
      await release().catch(() => {});
      throw error;
    }
  }

  async markEntryRecentlyUsed(
    script: ScriptReference,
    fingerprint: Fingerprint,
  ): Promise<void> {
    const cachePackageDir = await this.#cachePackageDir(script);
    this.#packageDirs.add(cachePackageDir);
    // Recency lives in the mtime, so there is no index file to maintain. atime
    // won't do, because filesystems are commonly mounted noatime or relatime.
    const now = new Date();
    try {
      await fs.utimes(
        this.#getCacheDir(cachePackageDir, script, fingerprint),
        now,
        now,
      );
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
    const cachePackageDir = await this.#cachePackageDir(script);
    this.#packageDirs.add(cachePackageDir);
    const absCacheDir = this.#getCacheDir(cachePackageDir, script, fingerprint);
    if (absoluteFiles.length === 0) {
      // No temp folder, because an empty "output" runs without the lock.
      //
      // The entry may already exist. Another worktree may have saved the same
      // empty output first. Then this save counts as done.
      await fs.mkdir(absCacheDir, {recursive: true});
    } else {
      await this.#writeThroughTemp(
        cachePackageDir,
        script,
        absoluteFiles,
        absCacheDir,
      );
      // This must run after this write's rename. Another worktree may be
      // saving into the same temp folder. So only leftovers over an hour old
      // are trashed.
      await this.#trashLeftoverTemp(cachePackageDir, script);
    }
    await this.#evictLeastRecentlyUsed(script, pathlib.basename(absCacheDir));
    return true;
  }

  /**
   * Copies into a temp folder and renames the copy into place. So a killed
   * Wireit can't leave a partial entry. Another worktree may save the same
   * entry at the same time, and only one rename can succeed. If the entry
   * already exists, the other save won, and this save counts as done.
   */
  async #writeThroughTemp(
    cachePackageDir: string,
    script: ScriptReference,
    absoluteFiles: AbsoluteEntry[],
    absCacheDir: string,
  ): Promise<void> {
    // Short, so a path that fits the Windows limit in the cache fits here.
    // Next to the cache entry, so the rename stays on one filesystem when a
    // linked worktree's cache lives in the main worktree.
    const tempDir = pathlib.join(
      this.#getScriptTempDir(cachePackageDir, script),
      randomBytes(8).toString('hex'),
    );
    await fs.mkdir(this.#getScriptCacheDir(cachePackageDir, script), {
      recursive: true,
    });
    try {
      await copyEntries(absoluteFiles, script.packageDir, tempDir);
      await fs.rename(tempDir, absCacheDir);
    } catch (error) {
      // Not moved to the trash, because creating the trash folder fails on a
      // full disk.
      await fs.rmTree(tempDir).catch(() => {});
      const {code} = error as {code?: string};
      if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM') {
        try {
          await fs.access(absCacheDir);
          return;
        } catch {
          throw error;
        }
      }
      throw error;
    }
  }

  /** Must run after this write's rename; see {@link set}. */
  async #trashLeftoverTemp(
    cachePackageDir: string,
    script: ScriptReference,
  ): Promise<void> {
    const tempDir = this.#getScriptTempDir(cachePackageDir, script);
    let leftovers;
    try {
      leftovers = await fs.readdir(tempDir, {withFileTypes: true});
    } catch {
      return;
    }
    // Another worktree may be saving into this folder right now. Trash only
    // the folders that are old enough to be left from an aborted save.
    const cutoff = Date.now() - TEMP_LEFTOVER_MIN_AGE_MS;
    const names = (
      await Promise.all(
        leftovers.map(async ({name}) => {
          try {
            const {mtimeMs} = await fs.lstat(pathlib.join(tempDir, name));
            return mtimeMs <= cutoff ? name : undefined;
          } catch {
            return undefined;
          }
        }),
      )
    ).filter((name): name is string => name !== undefined);
    await Promise.allSettled(
      names.map((name) =>
        this.#moveToTrash(cachePackageDir, pathlib.join(tempDir, name)),
      ),
    );
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
      const cachePackageDir = await this.#cachePackageDir(script);
      const cacheDir = this.#getScriptCacheDir(cachePackageDir, script);
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
      // Skip an entry that another run is restoring or evicting. Deleting an
      // entry during a restore would corrupt the restore. Evict the next
      // oldest entry instead. If one entry fails to move, continue with the
      // rest. For example, Windows fails with EPERM while a program has the
      // entry open.
      const quota = Math.min(
        entries.length - this.#maxEntries,
        MAX_EVICTIONS_PER_WRITE,
      );
      let evicted = 0;
      for (const {path} of byRecency) {
        if (evicted >= quota) {
          break;
        }
        const release = await this.#lockForEviction(
          this.#getEntryLockDir(
            cachePackageDir,
            script,
            pathlib.basename(path),
          ),
        );
        if (release === undefined) {
          continue;
        }
        try {
          await this.#moveToTrash(cachePackageDir, path);
          evicted++;
        } catch {
          // Housekeeping: the entry just written is still valid.
        } finally {
          await release().catch(() => {});
        }
      }
      const numLeft = entries.length - evicted;
      if (numLeft > REMIND_OVER_LIMIT_FACTOR * this.#maxEntries) {
        // Pass the package that holds the cache. With WIREIT_CACHE_WORKTREES,
        // a linked worktree's cache is in the main worktree.
        await this.#remindOverLimit(cachePackageDir);
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

  /**
   * Returns the folder of locks for one cache entry. The folder is next to
   * the cache folder, so evicting or sweeping the entry never moves the locks.
   *
   * Each restore takes its own lock in the folder. Its name is
   * {@link RESTORE_LOCK_PREFIX} followed by random hex digits. So restores in
   * different worktrees never wait for each other. An eviction takes the
   * {@link EVICT_LOCK} lock. It evicts the entry only if no restore holds a
   * lock. When a restore finds {@link EVICT_LOCK} held, it releases its own
   * lock and tries again.
   *
   * Each side takes its own lock before it checks for the other side's lock.
   * This order makes sure that at least one side sees the other.
   *
   * Each lock is a ".lock" folder. Releasing the last lock also deletes the
   * entry's lock folder. So nothing is left when no lock is held.
   */
  #getEntryLockDir(
    cachePackageDir: string,
    script: ScriptReference,
    entryName: string,
  ): string {
    return pathlib.join(
      getScriptDataDir({packageDir: cachePackageDir, name: script.name}),
      'cache-locks',
      entryName,
    );
  }

  /** Takes a restore lock. Waits while an eviction of the entry is running. */
  async #lockForRestore(lockDir: string): Promise<() => Promise<void>> {
    while (true) {
      const release = await this.#lockIn(
        lockDir,
        RESTORE_LOCK_PREFIX + randomBytes(8).toString('hex'),
      );
      if (
        !(await lockfile.check(
          pathlib.join(lockDir, EVICT_LOCK),
          ENTRY_LOCK_OPTIONS,
        ))
      ) {
        return release;
      }
      await release();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  /**
   * Takes the eviction lock. Returns undefined if another eviction holds it.
   * Also returns undefined if a restore holds a lock.
   */
  async #lockForEviction(
    lockDir: string,
  ): Promise<(() => Promise<void>) | undefined> {
    let release;
    try {
      release = await this.#lockIn(lockDir, EVICT_LOCK);
    } catch (error) {
      if ((error as {code?: string}).code === 'ELOCKED') {
        return undefined;
      }
      throw error;
    }
    let names: string[];
    try {
      names = (await fs.readdir(lockDir, {withFileTypes: true})).map(
        (entry) => entry.name,
      );
    } catch (error) {
      await release();
      throw error;
    }
    for (const name of names) {
      if (!name.startsWith(RESTORE_LOCK_PREFIX) || !name.endsWith('.lock')) {
        continue;
      }
      const restoreLock = pathlib.join(lockDir, name.slice(0, -'.lock'.length));
      if (await lockfile.check(restoreLock, ENTRY_LOCK_OPTIONS)) {
        await release();
        return undefined;
      }
      // This lock is stale. A restore crashed while it held the lock. Delete
      // the lock so that the folder can be deleted later.
      await fs.rmdir(pathlib.join(lockDir, name)).catch(() => {});
    }
    return release;
  }

  /**
   * Takes the lock named {@link name} in {@link lockDir}. The returned
   * function releases the lock. It also deletes the folder if the folder holds
   * no other lock.
   */
  async #lockIn(lockDir: string, name: string): Promise<() => Promise<void>> {
    while (true) {
      await fs.mkdir(lockDir, {recursive: true});
      let release;
      try {
        release = await lockfile.lock(
          pathlib.join(lockDir, name),
          ENTRY_LOCK_OPTIONS,
        );
      } catch (error) {
        // Another run released its lock and deleted the folder after this run
        // created it. Create the folder again.
        if ((error as {code?: string}).code === 'ENOENT') {
          continue;
        }
        throw error;
      }
      return async () => {
        await release();
        await fs.rmdir(lockDir).catch(() => {});
      };
    }
  }

  async #cachePackageDir(script: ScriptReference): Promise<string> {
    if (!this.#shareWorktrees) {
      return script.packageDir;
    }
    const {packageDir} = script;
    let cachePackageDir = this.#cachePackageDirs.get(packageDir);
    if (cachePackageDir === undefined) {
      cachePackageDir = resolveCachePackageDir(packageDir, {
        shareWorktrees: true,
      });
      this.#cachePackageDirs.set(packageDir, cachePackageDir);
      // Forget a failed lookup. The next call tries again.
      cachePackageDir.catch(() => this.#cachePackageDirs.delete(packageDir));
    }
    return cachePackageDir;
  }

  #getScriptCacheDir(cachePackageDir: string, script: ScriptReference): string {
    return pathlib.join(
      getScriptDataDir({packageDir: cachePackageDir, name: script.name}),
      'cache',
    );
  }

  #getScriptTempDir(cachePackageDir: string, script: ScriptReference): string {
    return pathlib.join(
      getScriptDataDir({packageDir: cachePackageDir, name: script.name}),
      'temp',
    );
  }

  #getCacheDir(
    cachePackageDir: string,
    script: ScriptReference,
    fingerprint: Fingerprint,
  ): string {
    return pathlib.join(
      this.#getScriptCacheDir(cachePackageDir, script),
      fingerprint.localCacheEntryName(this.#shareWorktrees),
    );
  }
}

/** Whether a call failed because the file system refused to write. */
const cannotWrite = (error: unknown) => {
  const code = (error as {code?: string}).code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
};

/** Whether {@link path} exists. */
const exists = async (path: string): Promise<boolean> => {
  try {
    await fs.access(path);
    return true;
  } catch (error) {
    if ((error as {code?: string}).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

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

  /**
   * Releases the entry's lock. {@link apply} calls it when the copy is done.
   * Until then, eviction in another worktree cannot delete the entry.
   */
  #release: (() => Promise<void>) | undefined;

  constructor(
    source: string,
    destination: string,
    release: () => Promise<void>,
  ) {
    this.#source = source;
    this.#destination = destination;
    this.#release = release;
  }

  async apply(): Promise<void> {
    try {
      const entries = await glob(['**'], {
        cwd: this.#source,
        followSymlinks: false,
        includeDirectories: true,
        expandDirectories: true,
        // Shouldn't ever happen, but would be really weird.
        throwIfOutsideCwd: true,
      });
      await copyEntries(entries, this.#source, this.#destination);
    } finally {
      await this.release();
    }
  }

  async release(): Promise<void> {
    const release = this.#release;
    this.#release = undefined;
    await release?.().catch(() => {});
  }
}
