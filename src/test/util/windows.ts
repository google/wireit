/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';

const IS_WINDOWS = process.platform === 'win32';

/**
 * If we're on Windows, replace all forward-slashes with back-slashes.
 */
export const windowsifyPathIfOnWindows = (path: string) =>
  IS_WINDOWS ? path.replaceAll(pathlib.posix.sep, pathlib.win32.sep) : path;
