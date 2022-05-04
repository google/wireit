/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as pathlib from 'path';
import {createHash} from 'crypto';
import {getScriptDataDir} from '../util/script-data-dir.js';
import {copyEntries} from '../util/copy.js';
import {glob} from '../util/glob.js';

import type {Cache, CacheHit} from './cache.js';
import type {ScriptReference, ScriptStateString} from '../script.js';
import type {RelativeEntry} from '../util/glob.js';

/**
 * Caches script output to each package's
 * ".wireit/<script-name-hex>/cache/<cache-key-sha256-hex>" folder.
 */
export class LocalCache implements Cache {
  async get(
    script: ScriptReference,
    cacheKey: ScriptStateString
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
    cacheKey: ScriptStateString,
    relativeFiles: RelativeEntry[]
  ): Promise<boolean> {
    // TODO(aomarks) A script's cache directory currently just grows forever.
    // We'll have the "clean" command to help with manual cleanup, but we'll
    // almost certainly want an automated way to limit the size of the cache
    // directory (e.g. LRU capped to some number of entries).
    // https://github.com/google/wireit/issues/71
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
    await copyEntries(relativeFiles, script.packageDir, absCacheDir);
    return true;
  }

  #getCacheDir(script: ScriptReference, cacheKey: ScriptStateString): string {
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
    const entries = await glob(['**'], {
      cwd: this.#source,
      absolute: false,
      followSymlinks: false,
      includeDirectories: true,
      expandDirectories: true,
    });
    await copyEntries(entries, this.#source, this.#destination);
  }
}
