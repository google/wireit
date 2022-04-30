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
