/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {sep, dirname} from 'path';

/**
 * Given a set of filesystem paths, returns the smallest set of recursive
 * {@link fs.cp} or {@link fs.rm} operations required to cover all paths.
 *
 * For example, given:
 *
 *   a/b/c
 *   a/b
 *   d
 *   d/e/f/g/h
 *
 * Returns:
 *
 *   a/b
 *   d
 *
 * Note this function does an in-place sort of the given paths.
 */
export const optimizeCpRms = (paths: string[]): string[] => {
  if (paths.length <= 1) {
    return paths;
  }
  const ops = [];
  // Default lexicographic sort ensures that parent directories come before and
  // are adjacent to their children (e.g. [b/c/d, a, b/c] => [a, b/c, b/c/d]).
  paths.sort();
  let lastOp;
  for (const path of paths) {
    if (
      lastOp !== undefined &&
      path.startsWith(lastOp) &&
      (path.length === lastOp.length || path[lastOp.length] === sep)
    ) {
      // Path is either identical to the last operation, or is a child of it. We
      // can skip this path, because fs.cp is recursive, and the last operation
      // already includes it (e.g. "a" already includes "a/b").
      continue;
    }
    ops.push(path);
    lastOp = path;
  }
  return ops;
};

/**
 * Given a set of filesystem directory paths, returns the smallest set of
 * recursive {@link fs.mkdir} operations required to create all directories.
 *
 *  For example, given:
 *
 *   a/b/c
 *   a/b
 *   d
 *   d/e/f/g/h
 *
 * Returns:
 *
 *   a/b/c
 *   d/e/f/g/h
 *
 * Note this function does an in-place sort of the given dirs.
 */
export const optimizeMkdirs = (dirs: string[]): string[] => {
  if (dirs.length <= 1) {
    return dirs;
  }
  const ops = [];
  // Sorting from longest to shortest ensures that child directories come before
  // parents (e.g. [d/e, d/e/f, a, a/b/c] => [d/e/f, a/b/c, d/e, a]).
  // Parent/child adjacency doesn't matter.
  dirs.sort((a, b) => b.length - a.length);
  const handled = new Set();
  for (const dir of dirs) {
    if (handled.has(dir)) {
      // Skip this directory because it has already been handled by a longer
      // path we've already seen (e.g. "a/b/c" also creates "a/b" and "a").
      continue;
    }
    ops.push(dir);
    // Add this directory and all of its parent directories to the "done" set.
    let cur = dir;
    while (true) {
      handled.add(cur);
      const parent = dirname(cur);
      if (parent === cur) {
        break;
      }
      cur = parent;
    }
  }
  return ops;
};
