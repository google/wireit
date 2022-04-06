/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as pathlib from 'path';
import {createHash} from 'crypto';
import {getScriptDataDir} from '../util/script-data-dir.js';
import {optimizeCopies, optimizeMkdirs} from '../util/optimize-fs-ops.js';

import type {Cache, CacheHit} from './cache.js';
import type {ScriptReference, CacheKeyString} from '../script.js';

/**
 * Caches script output to each package's
 * ".wireit/<script-name-hex>/cache/<cache-key-sha256-hex>" folder.
 */
export class LocalCache implements Cache {
  async get(
    script: ScriptReference,
    cacheKey: CacheKeyString
  ): Promise<CacheHit | undefined> {
    const cacheDir = this.#getCacheDir(script, cacheKey);
    try {
      await fs.access(cacheDir);
    } catch (error) {
      if ((error as Error & {code?: string}).code === 'ENOENT') {
        return;
      }
      throw error;
    }
    return new LocalCacheHit(cacheDir, script.packageDir);
  }

  async set(
    script: ScriptReference,
    cacheKey: CacheKeyString,
    relativeFiles: string[]
  ): Promise<void> {
    // TODO(aomarks) A script's cache directory currently just grows forever.
    // We'll have the "clean" command to help with manual cleanup, but we'll
    // almost certainly want an automated way to limit the size of the cache
    // directory (e.g. LRU capped to some number of entries).
    // https://github.com/lit/wireit/issues/71
    const absCacheDir = this.#getCacheDir(script, cacheKey);
    // Note fs.mkdir returns the first created directory, or undefined if no
    // directory was created.
    const existed =
      (await fs.mkdir(absCacheDir, {recursive: true})) === undefined;
    if (existed) {
      // This is an unexpected error because the Executor should already have
      // checked for an existing cache hit.
      throw new Error(`Did not expect ${absCacheDir} to already exist.`);
    }
    // Compute the smallest set of recursive fs.cp and fs.mkdir operations
    // needed to cover all of the files.
    const copyOps = optimizeCopies(relativeFiles);
    const mkdirOps = optimizeMkdirs(
      copyOps.map((path) => pathlib.dirname(path))
    );
    await Promise.all(
      mkdirOps.map((dir) =>
        fs.mkdir(pathlib.join(absCacheDir, dir), {recursive: true})
      )
    );
    await Promise.all(
      copyOps.map((file) =>
        // TODO(aomarks) fs.cp is experimental and was added in Node 16.7.0. It
        // could be removed or changed in the future
        // (https://nodejs.org/api/fs.html#fscpsrc-dest-options-callback). We're
        // using it here because unlike fs.copyFile, it is able to copy a
        // symlink without dereferencing it, and because it can recursively copy
        // an entire directory.
        fs.cp(
          pathlib.join(script.packageDir, file),
          pathlib.join(absCacheDir, file),
          {
            recursive: true,
            // Copy symlinks as symlinks, instead of following them.
            dereference: false,
          }
        )
      )
    );
  }

  #getCacheDir(script: ScriptReference, cacheKey: CacheKeyString): string {
    return pathlib.join(
      getScriptDataDir(script),
      'cache',
      createHash('sha256').update(cacheKey).digest('hex')
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
    // TODO(aomarks) See note above about experimental status of fs.cp.
    await fs.cp(this.#source, this.#destination, {
      recursive: true,
      // Copy symlinks as symlinks, instead of following them.
      dereference: false,
    });
  }
}
