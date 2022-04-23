/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as pathlib from 'path';
import {optimizeMkdirs} from './optimize-fs-ops.js';
import {constants} from 'fs';

import type {RelativeEntry} from './glob.js';

/**
 * Copy all of the given files and directories from one directory to another.
 *
 * Directories are NOT copied recursively. If a directory is listed in
 * {@link entries} without any of its children being listed, then an empty
 * directory will be created.
 *
 * Parent directories are created automatically. E.g. listing "foo/bar" will
 * automatically create "foo/", even if "foo/" wasn't listed.
 */
export const copyEntries = async (
  entries: RelativeEntry[],
  sourceDir: string,
  destDir: string
): Promise<void> => {
  if (entries.length === 0) {
    return;
  }

  const files = new Set<string>();
  const symlinks = new Set<string>();
  const directories = new Set<string>();
  for (const {path: relativePath, dirent} of entries) {
    if (dirent.isDirectory()) {
      directories.add(pathlib.join(destDir, relativePath));
    } else {
      directories.add(pathlib.join(destDir, pathlib.dirname(relativePath)));
      if (dirent.isSymbolicLink()) {
        symlinks.add(relativePath);
      } else {
        files.add(relativePath);
      }
    }
  }

  await Promise.all(
    optimizeMkdirs([...directories]).map((path) =>
      fs.mkdir(path, {recursive: true})
    )
  );

  const copyPromises = [];
  for (const path of files) {
    copyPromises.push(
      copyFileGracefully(
        pathlib.join(sourceDir, path),
        pathlib.join(destDir, path)
      )
    );
  }
  for (const path of symlinks) {
    copyPromises.push(
      copySymlinkGracefully(
        pathlib.join(sourceDir, path),
        pathlib.join(destDir, path)
      )
    );
  }
  await Promise.all(copyPromises);
};

/**
 * Copy a file. If the source doesn't exist, do nothing. If the destination
 * already exists, throw an error.
 */
const copyFileGracefully = async (src: string, dest: string): Promise<void> => {
  try {
    await fs.copyFile(src, dest, constants.COPYFILE_EXCL);
  } catch (error) {
    const {code} = error as {code: string};
    if (code === /* does not exist */ 'ENOENT') {
      return;
    }
    throw error;
  }
};

/**
 * Copy a symlink verbatim without following or resolving the target. If the
 * source doesn't exist, do nothing.
 */
const copySymlinkGracefully = async (
  src: string,
  dest: string
): Promise<void> => {
  try {
    const target = await fs.readlink(src, {encoding: 'buffer'});
    await fs.symlink(target, dest);
  } catch (error) {
    const {code} = error as {code: string};
    if (code === /* does not exist */ 'ENOENT') {
      return;
    }
    throw error;
  }
};
