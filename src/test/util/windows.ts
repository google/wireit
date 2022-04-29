/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const IS_WINDOWS = process.platform === 'win32';

/**
 * If we're on Windows, replace all forward-slashes with back-slashes.
 */
export const windowsifyPathIfOnWindows = (path: string) =>
  IS_WINDOWS ? path.replace(/\//g, '\\') : path;
