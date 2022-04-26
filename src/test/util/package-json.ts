/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A raw package.json JSON object, including the special "wireit" section.
 *
 * Useful when writing tests with valid input.
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
      clean?: boolean | 'if-file-deleted';
      packageLocks?: string[];
    };
  };
}
