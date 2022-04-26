/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import * as fs from 'fs/promises';
import { AstNode, parseTree } from './ast.js';
import { PlaceholderConfig } from '../analyzer.js';

export const astKey = Symbol('ast');

/**
 * Reads package.json files and caches them.
 */
export class CachingPackageJsonReader {
  readonly #cache = new Map<string, AstNode>();

  async read(packageDir: string, placeholder: PlaceholderConfig): Promise<AstNode> {
    let ast = this.#cache.get(packageDir);
    if (ast === undefined) {
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
      ast = parseTree(packageJsonStr, placeholder);
      this.#cache.set(packageDir, ast);
    }
    return ast;
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
