/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Whether we're running on Windows.
 */
export const IS_WINDOWS = process.platform === 'win32';

/**
 * If we're on Windows, convert all back-slashes to forward-slashes (e.g.
 * "foo\bar" -> "foo/bar").
 */
export const posixifyPathIfOnWindows = (path: string) =>
  IS_WINDOWS ? path.replace(/\\/g, '/') : path;

/**
 * Overlay the given environment variables on top of the current process's
 * environment variables in a way that is reliable on Windows.
 *
 * Windows environment variable names are **sort of** case-insensitive. When you
 * `spawn` a process and pass 2 environment variables that differ only in case,
 * then the value that actually gets set is ambiguous, and depends on the Node
 * version. In Node 14 it seems to be the last one in iteration order, in Node
 * 16 it seems to be the first one after sorting.
 *
 * For example, if you run:
 *
 * ```ts
 * spawn('foo', {
 *   env: {
 *     PATH: 'C:\\extra;C:\\before',
 *     Path: 'C:\\before'
 *   }
 * });
 * ```
 *
 * Then sometimes the value that the spawned process receives could be
 * `C:\before`, and other times it could be `C:\extra;C:\before`.
 *
 * This function ensures that the values given in `augmentations` will always
 * win, by normalizing casing to match the casing that was already set in
 * `process.env`.
 */
export const augmentProcessEnvSafelyIfOnWindows = (
  augmentations: Record<string, string | undefined>,
): Record<string, string | undefined> => {
  if (ENVIRONMENT_VARIABLE_CASINGS_IF_WINDOWS === undefined) {
    // On Linux and macOS, environment variables are case-sensitive, so there's
    // nothing special to do here.
    return {...process.env, ...augmentations};
  }
  const augmented = {...process.env};
  for (const [name, value] of Object.entries(augmentations)) {
    const existingNames = ENVIRONMENT_VARIABLE_CASINGS_IF_WINDOWS.get(
      name.toLowerCase(),
    );
    if (existingNames === undefined) {
      augmented[name] = value;
    } else {
      for (const existingName of existingNames) {
        augmented[existingName] = value;
      }
    }
  }
  return augmented;
};

/**
 * A map from lowercase environment variable name to the specific name casing(s)
 * that were found in this process's environment variables.
 *
 * This is an array because in Node 14 the `process.env` object can actually
 * contain multiple entries for the same variable with different casings, even
 * though the values are always the same. In Node 16, there is only one name
 * casing, even if it was spawned with multiple.
 */
const ENVIRONMENT_VARIABLE_CASINGS_IF_WINDOWS = IS_WINDOWS
  ? (() => {
      const map = new Map<string, string[]>();
      for (const caseSensitiveName of Object.keys(process.env)) {
        const lowerCaseName = caseSensitiveName.toLowerCase();
        let arr = map.get(lowerCaseName);
        if (arr === undefined) {
          arr = [];
          map.set(lowerCaseName, arr);
        }
        arr.push(caseSensitiveName);
      }
      return map;
    })()
  : undefined;
