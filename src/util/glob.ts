/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fastGlob from 'fast-glob';
import braces from 'braces';
import * as pathlib from 'path';

import type {Entry} from 'fast-glob';

export type AbsoluteEntry = Entry & {_AbsoluteEntryBrand_: never};
export type RelativeEntry = Entry & {_RelativeEntryBrand_: never};

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
   * If true, symlinks are followed, and the entry dirents will identify as
   * normal files/directories. If false, symlinks are not followed, and the
   * entry dirents will identify as symlinks.
   */
  followSymlinks: boolean;

  /**
   * Whether to include directories in the results.
   */
  includeDirectories: boolean;

  /**
   * Whether to recursively expand any matched directory.
   * Note this works even if includeDirectories is false.
   */
  expandDirectories: boolean;

  /**
   * If true, interpret `/` as the `cwd`, but still allow `../` for referring
   * outside of `cwd` (for example, `/foo` is interpreted as `<cwd>/foo`). If
   * false, `/` refers to the root of the filesystem.
   */
  rerootToCwd: boolean;
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
export async function glob(
  patterns: string[],
  opts: GlobOptions & {absolute: true}
): Promise<AbsoluteEntry[]>;
export async function glob(
  patterns: string[],
  opts: GlobOptions & {absolute: false}
): Promise<RelativeEntry[]>;
export async function glob(
  patterns: string[],
  opts: GlobOptions
): Promise<AbsoluteEntry[] | RelativeEntry[]>;
export async function glob(
  patterns: string[],
  opts: GlobOptions
): Promise<AbsoluteEntry[] | RelativeEntry[]> {
  if (patterns.length === 0) {
    return [];
  }

  const expandedPatterns = []; // New array so we don't mutate input patterns array.
  for (const pattern of patterns) {
    // We need to expand `{foo,bar}` style brace patterns ourselves so that we
    // can reliably interpret the syntax of the pattern. For example, for
    // re-rooting we need to check for a leading `/`, but we can't do that
    // directly on `{/foo,/bar}`.
    for (const expanded of braces(pattern, {expand: true})) {
      expandedPatterns.push(expanded);
      if (opts.expandDirectories) {
        // Also include a recursive-children version of every pattern, in case
        // the pattern refers to a directory. This gives us behavior similar to
        // the npm package.json "files" array, where matching a directory
        // implicitly includes all transitive children.
        if (!isRecursive(expanded)) {
          expandedPatterns.push(expanded + '/**');
        }
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
    let pattern = expandedPatterns[i];
    const isExclusive = pattern[0] === '!';
    if (isExclusive) {
      pattern = pattern.slice(1); // Remove the "!"
    }
    if (opts.rerootToCwd) {
      pattern = pattern.replace(/^\/+/, '');
    }
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
      currentGroup.exclude.push(pattern);
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
  const combinedMap = new Map<string, Entry>();
  await Promise.all(
    groups.map(async ({include, exclude}) => {
      const matches = await fastGlob(include, {
        ignore: exclude,
        cwd: opts.cwd,
        dot: true,
        onlyFiles: !opts.includeDirectories,
        absolute: opts.absolute,
        followSymbolicLinks: opts.followSymlinks,
        // This should have no overhead because fast-glob already uses these
        // objects for its internal representation:
        // https://github.com/mrmlnc/fast-glob#objectmode
        objectMode: true,
        // Since we append "/**" to patterns above, we will sometimes get
        // ENOTDIR errors when the path we appended to was not a directory. We
        // can't know in advance which patterns refer to directories.
        suppressErrors: true,
        // We already do brace expansion ourselves. Doing it again would be
        // inefficient and would also break brace escaping.
        braceExpansion: false,
      });
      for (const match of matches) {
        combinedMap.set(match.path, match);
      }
    })
  );

  const combinedArr = [...combinedMap.values()];
  if (pathlib.sep === '\\') {
    for (const entry of combinedArr) {
      // fast-glob always returns "/" separated paths, even on Windows. Convert
      // to the OS-native separator.
      entry.path = pathlib.normalize(entry.path);
    }
  }
  return combinedArr as AbsoluteEntry[] | RelativeEntry[];
}

const isRecursive = (pattern: string): boolean =>
  pattern === '**' ||
  pattern === '**/*' ||
  pattern.endsWith('/**') ||
  pattern.endsWith('/**/*');
