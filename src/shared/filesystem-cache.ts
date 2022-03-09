/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import fastglob from 'fast-glob';
import * as pathlib from 'path';
import * as fs from 'fs/promises';
import {createHash} from 'crypto';

import type {Cache} from './cache.js';

export class FilesystemCache implements Cache {
  async getOutput(
    packageJsonPath: string,
    scriptName: string,
    cacheKey: string
  ): Promise<FilesystemCachedOutput | undefined> {
    const packageRoot = pathlib.dirname(packageJsonPath);
    const cacheDir = pathlib.resolve(
      packageRoot,
      '.wireit',
      'cache',
      scriptName,
      hashCacheKey(cacheKey)
    );
    try {
      await fs.access(cacheDir);
    } catch (err) {
      if ((err as {code?: string}).code === 'ENOENT') {
        return undefined;
      }
      throw err;
    }
    return new FilesystemCachedOutput(cacheDir, packageRoot);
  }

  async saveOutput(
    packageJsonPath: string,
    scriptName: string,
    cacheKey: string,
    scriptOutputGlobs: string[]
  ): Promise<void> {
    // TODO(aomarks) Think about symlinks, here and in normal run mode.
    // TODO(aomarks) Note that you can pass a custom "fs" to fastglob.
    const packageRoot = pathlib.dirname(packageJsonPath);
    const entries = await fastglob(scriptOutputGlobs, {
      cwd: packageRoot,
      dot: true,
      followSymbolicLinks: false,
    });
    const cacheDir = pathlib.resolve(
      packageRoot,
      '.wireit',
      'cache',
      scriptName,
      hashCacheKey(cacheKey)
    );
    const copies = [];
    // Create the dirname even if there are no files to save, so that we can get
    // a cache hit even in that case.
    await fs.mkdir(cacheDir, {recursive: true});
    for (const outputFilePath of entries) {
      const absSrc = pathlib.resolve(packageRoot, outputFilePath);
      // TODO(aomarks) Check that we are still within the cache dir. Could it be
      // valid for a script to emit outside of the package?
      const absDest = pathlib.resolve(cacheDir, outputFilePath);
      copies.push(
        fs
          .mkdir(pathlib.dirname(absDest), {recursive: true})
          .then(() => fs.copyFile(absSrc, absDest))
      );
    }
    await Promise.all(copies);
  }
}

const hashCacheKey = (key: string): string =>
  createHash('sha256').update(key).digest('hex');

class FilesystemCachedOutput {
  private readonly _sourceDir: string;
  private readonly _destDir: string;

  constructor(sourceDir: string, destDir: string) {
    this._sourceDir = sourceDir;
    this._destDir = destDir;
  }

  async apply(): Promise<void> {
    // TODO(aomarks) What about CLEARING the output dir?
    return fs.cp(this._sourceDir, this._destDir, {recursive: true});
  }
}
