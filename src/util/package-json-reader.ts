/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import * as fs from 'fs/promises';

/**
 * A raw package.json JSON object, including the special "wireit" section.
 */
export interface PackageJson {
  name?: string;
  version?: string;
  scripts?: {[scriptName: string]: string};
  wireit?: {
    [scriptName: string]: {
      command?: string;
      dependencies?: string[];
      files?: string[];
      output?: string[];
      clean?: boolean;
      packageLocks?: string[];
    };
  };
}

/**
 * Reads package.json files and caches them.
 */
export class CachingPackageJsonReader {
  readonly #cache = new Map<string, PackageJson>();

  async read(packageDir: string): Promise<PackageJson> {
    let packageJson = this.#cache.get(packageDir);
    if (packageJson === undefined) {
      const packageJsonPath = pathlib.resolve(packageDir, 'package.json');
      let packageJsonStr: string;
      try {
        packageJsonStr = await fs.readFile(packageJsonPath, 'utf8');
      } catch (error) {
        if ((error as {code?: string}).code === 'ENOENT') {
          throw new CachingPackageJsonReaderError('missing-package-json');
        }
        throw error;
      }
      try {
        packageJson = JSON.parse(packageJsonStr) as PackageJson;
      } catch (error) {
        throw new CachingPackageJsonReaderError('invalid-package-json');
      }
      this.#cache.set(packageDir, packageJson);
    }
    return packageJson;
  }
}

/**
 * An exception thrown by {@link CachingPackageJsonReader}.
 *
 * Note we don't use {@link WireitError} here because we don't have the full
 * context of the script we're trying to evaluate.
 */
class CachingPackageJsonReaderError extends Error {
  reason: 'missing-package-json' | 'invalid-package-json';

  constructor(reason: CachingPackageJsonReaderError['reason']) {
    super(reason);
    this.reason = reason;
  }
}

// Export the interface of this class, but not the class itself.
export type {CachingPackageJsonReaderError};
