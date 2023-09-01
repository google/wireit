/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from './fs.js';
import * as pathlib from 'path';

import type {AbsoluteEntry} from './glob.js';

/**
 * Delete all of the given files and directories.
 *
 * Directories are NOT deleted recursively. To delete a directory, it must
 * either already be empty, or all of its transitive children must be explicitly
 * provided in the {@link entries} parameter. Deletes are performed depth-first
 * so that children are deleted before their parents. If a directory is still
 * not empty after all of the provided children have been deleted, then it is
 * left in-place.
 */
export const deleteEntries = async (
  entries: AbsoluteEntry[],
): Promise<void> => {
  if (entries.length === 0) {
    return;
  }

  const directories = [];
  const unlinkPromises = [];
  for (const {path, dirent} of entries) {
    if (dirent.isDirectory()) {
      // Don't delete directories yet.
      directories.push(path);
    } else {
      // Files can start deleting immediately.
      unlinkPromises.push(unlinkGracefully(path));
    }
  }

  // Wait for all files to be deleted before we start deleting directories,
  // because directories need to be empty to be deleted.
  await Promise.all(unlinkPromises);

  if (directories.length === 0) {
    return;
  }
  if (directories.length === 1) {
    // Minor optimization for the common case of 1 directory. We've already
    // deleted all regular files, and we don't delete directories recursively.
    // So either [1] this directory is empty and we should delete it, or [2] it
    // has a child directory that was not explicitly listed so we should leave
    // it in-place.
    await rmdirGracefully(directories[0]!);
    return;
  }

  // We have multiple directories to delete. We must delete child directories
  // before their parents, because directories need to be empty to be deleted.
  //
  // Sorting from longest to shortest path and deleting in serial is a simple
  // solution, but we prefer to go in parallel.
  //
  // Build a tree from the path hierarchy, then delete depth-first.
  const root: Directory = {children: {}};
  for (const path of directories) {
    let cur = root;
    for (const part of path.split(pathlib.sep)) {
      cur = cur.children[part] ??= {children: {}};
    }
    cur.pathIfShouldDelete = path;
  }
  await deleteDirectoriesDepthFirst(root);
};

interface Directory {
  /** If this directory should be deleted, its full path. */
  pathIfShouldDelete?: string;
  /** Child directories that need to be deleted first. */
  children: {[dir: string]: Directory};
}

/**
 * Walk a {@link Directory} tree depth-first, deleting any directories that were
 * scheduled for deletion as long as they are empty.
 */
const deleteDirectoriesDepthFirst = async (
  directory: Directory,
): Promise<boolean> => {
  const childrenDeleted = await Promise.all(
    Object.values(directory.children).map((child) =>
      deleteDirectoriesDepthFirst(child),
    ),
  );
  if (directory.pathIfShouldDelete === undefined) {
    // This directory wasn't scheduled for deletion.
    return false;
  }
  if (childrenDeleted.some((deleted) => !deleted)) {
    // A child directory wasn't deleted, so there's no point trying to delete
    // this directory, because we know we're not empty and would fail.
    return false;
  }
  return rmdirGracefully(directory.pathIfShouldDelete);
};

/**
 * Delete a file. If it doesn't exist, do nothing.
 */
const unlinkGracefully = async (path: string): Promise<void> => {
  try {
    await fs.unlink(path);
  } catch (error) {
    const {code} = error as {code: string};
    if (code === /* does not exist */ 'ENOENT') {
      return;
    }
    throw error;
  }
};

/**
 * Delete a directory. If it doesn't exist or isn't empty, do nothing.
 *
 * @returns True if the directory was deleted or already didn't exist. False
 * otherwise.
 */
const rmdirGracefully = async (path: string): Promise<boolean> => {
  try {
    await fs.rmdir(path);
  } catch (error) {
    const {code} = error as {code: string};
    if (code === /* does not exist */ 'ENOENT') {
      return true;
    }
    if (code === /* not empty */ 'ENOTEMPTY') {
      return false;
    }
    throw error;
  }
  return true;
};
