/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

/**
 * A raw package.json JSON object.
 */
export interface PackageJson {
  scripts?: {[scriptName: string]: string};
  wireit?: {[scriptName: string]: RawScript};
  workspaces?: string[];
}

/**
 * A wireit script config directly from the package.json.
 */
export interface RawScript {
  command?: string;
  dependencies?: string[];
  files?: string[];
  output?: string[];
  checkPackageLocks?: boolean;
  deleteOutputBeforeEachRun?: boolean;
  incrementalBuildFiles?: string[];
}

/**
 * A fully resolved reference to a script in a specific package.
 */
export interface ResolvedScriptReference {
  /** Absolute path to the package. */
  // TODO(aomarks) Change this to just package.
  packageJsonPath: string;
  /** A concrete script name (no ./ or $WORKSPACES etc.) */
  scriptName: string;
}

/**
 * A wireit package with its raw unresolved scripts.
 */
export interface RawPackageConfig {
  packageJsonPath: string;
  scripts: {[scriptName: string]: RawScript};
}
