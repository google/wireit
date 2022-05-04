/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import * as fs from 'fs/promises';
import {parseTree} from './ast.js';

import type {PlaceholderConfig} from '../analyzer.js';
import type {JsonAstNode} from './ast.js';

export const astKey = Symbol('ast');

export interface JsonFile {
  path: string;
  ast: JsonAstNode;
  contents: string;
}

/**
 * Reads package.json files and caches them.
 */
export class CachingPackageJsonReader {
  readonly #cache = new Map<string, JsonFile>();

  async read(
    packageDir: string,
    placeholder: PlaceholderConfig
  ): Promise<JsonFile> {
    let file = this.#cache.get(packageDir);
    if (file === undefined) {
      const path = pathlib.resolve(packageDir, 'package.json');
      let contents;
      try {
        contents = await fs.readFile(path, 'utf8');
      } catch (error) {
        if ((error as {code?: string}).code === 'ENOENT') {
          throw new CachingPackageJsonReaderError('missing-package-json');
        }
        throw error;
      }
      const ast = parseTree(path, contents, placeholder);
      file = {path, ast, contents};
      this.#cache.set(packageDir, file);
    }
    return file;
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
