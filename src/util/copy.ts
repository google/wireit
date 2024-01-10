/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from './fs.js';
import * as pathlib from 'path';
import {optimizeMkdirs} from './optimize-mkdirs.js';
import {IS_WINDOWS} from '../util/windows.js';

import type {AbsoluteEntry} from './glob.js';

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
  entries: AbsoluteEntry[],
  sourceDir: string,
  destDir: string,
): Promise<void> => {
  if (entries.length === 0) {
    return;
  }

  const files = new Set<string>();
  const symlinks = new Set<string>();
  const directories = new Set<string>();
  for (const {path: absolutePath, dirent} of entries) {
    const relativePath = pathlib.relative(sourceDir, absolutePath);
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
      fs.mkdir(path, {recursive: true}),
    ),
  );

  const copyPromises = [];
  for (const path of files) {
    copyPromises.push(
      copyFileGracefully(
        pathlib.join(sourceDir, path),
        pathlib.join(destDir, path),
      ),
    );
  }
  for (const path of symlinks) {
    copyPromises.push(
      copySymlinkGracefully(
        pathlib.join(sourceDir, path),
        pathlib.join(destDir, path),
      ),
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
    await fs.copyFile(
      src,
      dest,
      // COPYFILE_FICLONE: Copy the file using copy-on-write semantics, so that
      //   the copy takes constant time and space. This is a noop currently
      //   on some platforms, but it's a nice optimization to have.
      //   See https://github.com/libuv/libuv/issues/2936 for macos support.
      fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE,
    );
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
  dest: string,
): Promise<void> => {
  try {
    const target = await fs.readlink(src, {encoding: 'buffer'});
    // Windows symlinks need to be flagged for whether the target is a file or a
    // directory. We can't derive that from the symlink itself, so we instead
    // need to check the type of the target.
    const windowsType = IS_WINDOWS
      ? // The target could be in the source or the destination, check both.
        (await detectWindowsSymlinkType(target, src)) ??
        (await detectWindowsSymlinkType(target, dest)) ??
        // It doesn't exist in either place, so there's no way to know. Just
        // assume "file".
        'file'
      : undefined;
    await fs.symlink(target, dest, windowsType);
  } catch (error) {
    const {code} = error as {code: string};
    if (code === /* does not exist */ 'ENOENT') {
      return;
    }
    throw error;
  }
};

/**
 * Resolve symlink {@link target} relative to {@link linkPath} and try to detect
 * whether the target is a file or directory. If the target doesn't exist,
 * returns undefined.
 */
const detectWindowsSymlinkType = async (
  target: Buffer,
  linkPath: string,
): Promise<'file' | 'dir' | undefined> => {
  const resolved = pathlib.resolve(
    pathlib.dirname(linkPath),
    target.toString(),
  );
  try {
    const stats = await fs.stat(resolved);
    return stats.isDirectory() ? 'dir' : 'file';
  } catch (error) {
    const {code} = error as {code: string};
    if (code === /* does not exist */ 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};
