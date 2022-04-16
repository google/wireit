/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fastGlob from 'fast-glob';
import * as pathlib from 'path';

/**
 * Options for {@link glob}.
 */
export interface GlobOptions {
  /**
   * The directory that glob patterns are interpreted relative to.
   */
  cwd: string;

  /**
   * If true, always return absolute paths. If false, always return relative
   * paths, including when a match is outside of the cwd (e.g. "../foo").
   */
  absolute: boolean;

  /**
   * Whether to include directories in the results.
   */
  includeDirectories: boolean;
}

/**
 * Match glob patterns against the file system.
 *
 * - Input patterns must be / separated.
 * - If a directory is matched, then all recursive contents of that directory
 *   are included.
 * - Matches are returned with the OS-specific separator.
 * - Dot (aka hidden) files are always matched.
 *
 * @param patterns The glob patterns to match. Must use forward-slash separator,
 * even on Windows.
 * @params opts See {@link GlobOptions}.
 */
export const glob = async (
  patterns: string[],
  opts: GlobOptions
): Promise<string[]> => {
  if (patterns.length === 0) {
    return [];
  }

  const matches = await fastGlob(patterns, {
    cwd: opts.cwd,
    dot: true,
    onlyFiles: !opts.includeDirectories,
    absolute: opts.absolute,
  });

  if (pathlib.sep === '\\') {
    for (let i = 0; i < matches.length; i++) {
      // fast-glob always returns "/" separated paths, even on Windows. Convert
      // to the OS-native separator.
      matches[i] = pathlib.normalize(matches[i]);
    }
  }

  return matches;
};
