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
   * Whether to recursively expand any matched directory.
   * Note this works even if includeDirectories is false.
   */
  expandDirectories: boolean;
}

interface GlobGroup {
  include: string[];
  exclude: string[];
}

/**
 * Match glob patterns against the file system.
 *
 * - Input patterns must be / separated.
 * - Matches are returned with the OS-specific separator.
 * - Dot (aka hidden) files are always matched.
 * - Empty or blank patterns throw.
 * - The order of "!exclusion" patterns matter (i.e. files can be "re-included"
 *   after exclusion).
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

  let expandedPatterns = patterns;
  if (opts.expandDirectories) {
    expandedPatterns = []; // New array so we don't mutate input patterns array.
    for (const pattern of patterns) {
      expandedPatterns.push(pattern);
      // Also include a recursive-children version of every pattern, in case the
      // pattern refers to a directory. This gives us behavior similar to the
      // npm package.json "files" array, where matching a directory implicitly
      // includes all transitive children.
      if (!isRecursive(pattern)) {
        expandedPatterns.push(pattern + '/**');
      }
    }
  }

  // fast-glob doesn't pay attention to the order of !excluded patterns. For
  // example, the following pattern array should include "foo/bar/baz", but
  // fast-glob excludes it:
  //
  //   foo/**
  //   !foo/bar/**
  //   foo/bar/baz  <-- wrongly excluded
  //   !foo/qux
  //
  // To fix this behavior, we divide the patterns into groups that can be
  // evaluated separately and then combined. We create a new group whenever an
  // !exclude pattern is in front of an include pattern, because that's when
  // this problem could occur, and we include all subsequent negations (but not
  // preceding ones) in each group:
  //
  //   Group 1:
  //     include: foo/**
  //     exclude: foo/bar/**
  //     exclude: foo/qux
  //
  //   Group 2:
  //     include: foo/bar/baz
  //     exclude: foo/qux

  let currentGroup: GlobGroup = {include: [], exclude: []};
  const groups = [currentGroup];
  let prevWasInclusive = false;

  // We want each group to include all subsequent negated patterns. The simplest
  // way to do that is to build the groups backwards.
  for (let i = expandedPatterns.length - 1; i >= 0; i--) {
    const pattern = expandedPatterns[i];
    const isExclusive = pattern[0] === '!';
    if (isExclusive) {
      if (prevWasInclusive) {
        // A new group is needed because this exclusion comes before an
        // inclusion.
        //
        //   foo/**
        //   !foo/bar/** <-- we are here
        //   foo/bar/baz <-- this is the previous one
        //   !foo/qux
        currentGroup = {include: [], exclude: []};
        for (const previousGroup of groups) {
          // Also include all exclusions we've accumulated so far into the new
          // group (since we're iterating backwards, these are the exclusions
          // that come after it).
          currentGroup.exclude.push(...previousGroup.exclude);
        }
        groups.push(currentGroup);
      }
      const inverted = pattern.slice(1); // Remove the "!"
      currentGroup.exclude.push(inverted);
    } else if (pattern.match(/^\s*$/)) {
      // fast-glob already throws on empty strings, but we also throw on
      // only-whitespace patterns.
      //
      // Note minor optimization here: there is no reason to check this regexp
      // on exclusive patterns, because by definition they start with a "!" so
      // can't have been empty/blank.
      throw new Error(
        `glob encountered empty or blank pattern: ${JSON.stringify(pattern)}`
      );
    } else {
      currentGroup.include.push(pattern);
    }
    prevWasInclusive = !isExclusive;
  }

  // Pass each group to fast-glob to match in parallel, and combine into a
  // single set.
  const combinedSet = new Set<string>();
  await Promise.all(
    groups.map(async ({include, exclude}) => {
      const matches = await fastGlob(include, {
        ignore: exclude,
        cwd: opts.cwd,
        dot: true,
        onlyFiles: !opts.includeDirectories,
        absolute: opts.absolute,
        // Since we append "/**" to patterns above, we will sometimes get
        // ENOTDIR errors when the path we appended to was not a directory. We
        // can't know in advance which patterns refer to directories.
        suppressErrors: true,
      });
      for (const match of matches) {
        combinedSet.add(match);
      }
    })
  );

  const combinedArr = [...combinedSet];
  if (pathlib.sep === '\\') {
    for (let i = 0; i < combinedArr.length; i++) {
      // fast-glob always returns "/" separated paths, even on Windows. Convert
      // to the OS-native separator.
      combinedArr[i] = pathlib.normalize(combinedArr[i]);
    }
  }
  return combinedArr;
};

const isRecursive = (pattern: string): boolean =>
  pattern === '**' ||
  pattern === '**/*' ||
  pattern.endsWith('/**') ||
  pattern.endsWith('/**/*');
