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

  /**
   * Whether to recursively expand any matched directory
   * Note this works even if includeDirectories is false.
   */
  expandDirectories: boolean;
}

/**
 * Match glob patterns against the file system.
 *
 * - Input patterns must be / separated.
 * - If a directory is matched, then all recursive contents of that directory
 *   are included.
 * - Matches are returned with the OS-specific separator.
 * - Dot (aka hidden) files are always matched.
 * - Empty or blank patterns throw.
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

  // fast-glob already throws on empty strings, but we also throw on
  // only-whitespace patterns.
  for (const pattern of patterns) {
    if (pattern.match(/^\s*$/)) {
      throw new Error(
        `glob encountered empty or blank pattern: ${JSON.stringify(pattern)}`
      );
    }
  }

  let expandedPatterns;
  if (opts.expandDirectories) {
    expandedPatterns = [];
    for (const pattern of patterns) {
      expandedPatterns.push(pattern);
      // Also include a recursive-children version of every pattern, in case the
      // pattern refers to a directory. This gives us behavior similar to
      // .gitignore files and the npm package.json "files" array, where matching
      // a directory implicitly includes all transitive children.
      if (!isRecursive(pattern)) {
        expandedPatterns.push(pattern + '/**');
      }
    }
  } else {
    expandedPatterns = patterns;
  }

  const matches = await fastGlob(expandedPatterns, {
    cwd: opts.cwd,
    dot: true,
    onlyFiles: !opts.includeDirectories,
    absolute: opts.absolute,
    // Since we append "/**" to patterns above, we will sometimes get ENOTDIR
    // errors when the path we appended to was not a directory. We can't know in
    // advance which patterns refer to directories.
    suppressErrors: true,
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

const isRecursive = (pattern: string): boolean =>
  pattern === '**' || pattern.endsWith('/**');
