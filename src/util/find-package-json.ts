/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import * as fs from './fs.js';

/**
 * TODO
 *
 * Latest node has a built-in for this, but as of February 2025 it is behind a
 * flag: https://nodejs.org/api/module.html#modulefindpackagejsonspecifier-base
 */
export async function findPackageJson(
  specifier: string,
  base: string,
): Promise<string> {
  let cur = base;
  while (true) {
    const packageJsonPath = path.join(
      cur,
      'node_modules',
      specifier,
      'package.json',
    );
    try {
      await fs.access(packageJsonPath);
      return packageJsonPath;
    } catch {
      const next = path.dirname(cur);
      if (next === cur) {
        break;
      }
      cur = next;
    }
  }
  throw new Error(`Could not find package.json for ${specifier}`);
}
