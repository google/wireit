/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fastGlob from 'fast-glob';
import braces from 'brace-expansion';
import * as pathlib from 'path';

import type {Entry} from 'fast-glob';

export type AbsoluteEntry = Entry & {_AbsoluteEntryBrand_: never};

/**
 * The error raised when {@link glob} matches a path that is outside of
 * {@link GlobOptions.cwd} when {@link GlobOptions.throwIfOutsideCwd} is `true`.
 */
export class GlobOutsideCwdError extends Error {
  constructor(path: string, cwd: string) {
    super(`${JSON.stringify(path)} was outside ${JSON.stringify(cwd)}`);
  }
}

/**
 * Options for {@link glob}.
 */
export interface GlobOptions {
  /**
   * The directory that glob patterns are interpreted relative to.
   */
  cwd: string;

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
   * If true, throw an exception if a file matches which is not under the cwd.
   */
  throwIfOutsideCwd: boolean;
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
 * - Leading `/`s are interpreted as relative to the `cwd`, instead of the root
 *   of the filesystem.
 * - Dot (aka hidden) files are always matched.
 * - Empty or blank patterns throw.
 * - The order of "!exclusion" patterns matter (i.e. files can be "re-included"
 *   after exclusion).
 * - Results are always absolute.
 *
 * @param patterns The glob patterns to match. Must use forward-slash separator,
 * even on Windows.
 * @params opts See {@link GlobOptions}.
 */
export async function glob(
  patterns: string[],
  opts: GlobOptions,
): Promise<AbsoluteEntry[]> {
  if (patterns.length === 0) {
    return [];
  }

  const expandedPatterns = []; // New array so we don't mutate input patterns array.
  for (const pattern of patterns) {
    // We need to expand `{foo,bar}` style brace patterns ourselves so that we
    // can reliably interpret the syntax of the pattern. For example, for
    // re-rooting we need to check for a leading `/`, but we can't do that
    // directly on `{/foo,/bar}`.
    const allExpanded = pattern === '' ? [''] : braces(pattern);
    for (const expanded of allExpanded) {
      expandedPatterns.push(expanded);
      if (opts.expandDirectories) {
        // Also include a recursive-children version of every pattern, in case
        // the pattern refers to a directory. This gives us behavior similar to
        // the npm package.json "files" array, where matching a directory
        // implicitly includes all transitive children.
        if (!isRecursive(expanded)) {
          const isExclusive = pattern[0] === '!';
          if (!isExclusive) {
            // We use the "ignore" feature of fast-glob for exclusive patterns,
            // which already automatically recursively excludes directories by
            // not recursing into them at all, so there is no need to also
            // generate a recursive version when excluding.
            expandedPatterns.push(
              expanded + (expanded.endsWith('/') ? '**' : '/**'),
            );
          }
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
    let pattern = expandedPatterns[i]!;
    const isExclusive = pattern[0] === '!';
    if (isExclusive) {
      pattern = pattern.slice(1); // Remove the "!"
    }
    // Ignore leading `/`s so that e.g. "/foo" is interpreted relative to the
    // cwd, instead of relative to the root of the filesystem. We want to include
    // >1 leading slashes, since those are technically valid paths too.
    pattern = pattern.replace(/^\/+/, '');
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
      currentGroup.exclude.push(
        // Trim trailing slashes because fast-glob does not understand trailing
        // slashes in "ignore" list entries (they have no effect!).
        pattern.replace(/\/+$/, ''),
      );
    } else if (pattern.match(/^\s*$/)) {
      // fast-glob already throws on empty strings, but we also throw on
      // only-whitespace patterns.
      //
      // Note minor optimization here: there is no reason to check this regexp
      // on exclusive patterns, because by definition they start with a "!" so
      // can't have been empty/blank.
      throw new Error(
        `glob encountered empty or blank pattern: ${JSON.stringify(pattern)}`,
      );
    } else {
      currentGroup.include.push(pattern);
    }
    prevWasInclusive = !isExclusive;
  }

  // Pass each group to fast-glob to match in parallel, and combine into a
  // single set.
  const combinedMap = new Map<string, Entry>();
  // Ensure the cwd is absolute and normalized so that we can do path string
  // comparisons.
  const normalizedCwd = pathlib.resolve(opts.cwd);
  const normalizedCwdWithTrailingSep = normalizedCwd + pathlib.sep;
  await Promise.all(
    groups.map(async ({include, exclude}) => {
      const matches = await fastGlob(include, {
        ignore: exclude,
        cwd: normalizedCwd,
        dot: true,
        onlyFiles: !opts.includeDirectories,
        absolute: true,
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
      const potentiallyProblematicSymlinkParents = new Set<string>();
      for (const match of matches) {
        // Normalize the path so that:
        //
        // 1. We have native path separators. fast-glob returns "/" even on
        //    Windows.
        //
        // 2. Remnants of input pattern syntax like ".." and trailing "/"s are
        //    removed (which fast-glob preserves in the results). Note that
        //    `fs.normalize` does not trim trailing "/"s, so we do that
        //    ourselves (`fs.resolve` does, but that also makes the path
        //    absolute).
        match.path = pathlib.normalize(match.path.replace(/\/+$/g, ''));
        if (opts.throwIfOutsideCwd) {
          const absPath = match.path;
          if (
            // Match "parent/child" and "parent", but not "parentx".
            !absPath.startsWith(normalizedCwdWithTrailingSep) &&
            absPath !== normalizedCwd
          ) {
            // TODO(aomarks) This check could in theory be done before we execute
            // the globs, but we'd need to be really sure we account for special
            // glob syntax, which could make it not 100% straightforward to do
            // path checking. Checking the resulting paths is straightforward
            // because we know they don't contain special syntax.
            throw new GlobOutsideCwdError(absPath, opts.cwd);
          }
        }
        combinedMap.set(match.path, match);
        if (
          opts.expandDirectories &&
          !opts.followSymlinks &&
          match.dirent.isSymbolicLink()
        ) {
          potentiallyProblematicSymlinkParents.add(match.path);
        }
      }
      if (potentiallyProblematicSymlinkParents.size > 0) {
        // When the user passes a path "foo" and expandDirectories is true, we
        // convert the pattern to "foo/**" (see above about expandDirectories
        // for why).
        //
        // However, what if "foo" is a symlink to a folder with some children,
        // and followSymbolicLinks is false (which is the combination of
        // settings we use when wireit globs output files for caching)?
        //
        // Well, if you pass "foo/**" to fast-glob where "foo" is a symlink to a
        // directory, it's actually going to follow the symlink and return its
        // children, even if followSymbolicLinks is false. (This seems fairly
        // reasonable, since otherwise it would always have to check all parent
        // directories of a path before reading any directory contents in case
        // there's a symlink somewhere up the tree).
        //
        // But that's bad for us, because if a wireit user has a script that
        // creates a symlink to a directory, and they list that symlink directly
        // in their output paths, then for the purposes of caching we really
        // just want to just restore the literal symlink, and not copy its
        // contents. (Otherwise it would be a symlink when built the first time,
        // but a regular folder with children when restored from cache).
        //
        // So, since we don't know whether we might have problematically
        // appended a "/**" to a symlink, we will instead filter out child
        // matches. (Otherwise we'd need to check every given path to see if
        // it's a symlink, and directly listed symlinks are pretty rare, this
        // post-hoc approach is probably more efficient on average).
        for (const match of combinedMap.values()) {
          // Walk up the file hierarchy to check if any parent was a symlink
          // that was also directly matched by the glob.
          let child = match.path;
          while (true) {
            const parent = pathlib.dirname(child);
            if (parent === child) {
              // Reached the filesystem root.
              break;
            }
            if (potentiallyProblematicSymlinkParents.has(parent)) {
              combinedMap.delete(match.path);
              break;
            }
            child = parent;
          }
        }
      }
    }),
  );

  return [...combinedMap.values()] as AbsoluteEntry[];
}

const isRecursive = (pattern: string): boolean =>
  pattern === '**' ||
  pattern === '**/*' ||
  pattern.endsWith('/**') ||
  pattern.endsWith('/**/*');
