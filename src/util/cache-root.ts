/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createHash} from 'crypto';
import * as fs from 'fs';
import * as pathlib from 'path';

export type WorktreeInfo = {
  worktreeRoot: string;
  mainWorktreeRoot: string;
};

/**
 * Directory whose `.wireit/` folder should hold this package's local cache
 * (not lock/fingerprint/manifest).
 *
 * - `cacheDir` set (WIREIT_CACHE_DIR): `{cacheDir}/{path-from-worktree-root}`.
 *   Without git, isolated by a hash of the absolute package path (no sharing).
 * - Linked git worktree: the same relative package under the main worktree.
 * - Otherwise: `packageDir` (Wireit's historical layout).
 */
export const resolveCachePackageDir = (
  packageDir: string,
  cacheDir?: string,
): string => {
  const absPackageDir = pathlib.resolve(packageDir);
  const worktree = detectWorktree(absPackageDir);
  const relPackage =
    worktree === undefined
      ? undefined
      : pathlib.relative(worktree.worktreeRoot, absPackageDir);

  if (cacheDir !== undefined && cacheDir !== '') {
    const root = pathlib.resolve(cacheDir);
    return relPackage === undefined
      ? pathlib.join(root, hashPath(absPackageDir))
      : pathlib.join(root, relPackage);
  }

  if (
    worktree !== undefined &&
    relPackage !== undefined &&
    worktree.worktreeRoot !== worktree.mainWorktreeRoot
  ) {
    return pathlib.join(worktree.mainWorktreeRoot, relPackage);
  }
  return absPackageDir;
};

export const detectWorktree = (startDir: string): WorktreeInfo | undefined => {
  const worktreeRoot = findGitAncestor(pathlib.resolve(startDir));
  if (worktreeRoot === undefined) {
    return undefined;
  }
  const dotGit = pathlib.join(worktreeRoot, '.git');
  const stat = lstatOrUndefined(dotGit);
  if (stat === undefined) {
    return undefined;
  }
  if (stat.isDirectory()) {
    return {worktreeRoot, mainWorktreeRoot: worktreeRoot};
  }
  if (!stat.isFile()) {
    return undefined;
  }
  const gitDir = readGitdirPointer(dotGit, worktreeRoot);
  if (gitDir === undefined) {
    return undefined;
  }
  const mainWorktreeRoot = readMainWorktreeRoot(gitDir);
  if (mainWorktreeRoot === undefined) {
    return undefined;
  }
  return {worktreeRoot, mainWorktreeRoot};
};

const findGitAncestor = (dir: string): string | undefined => {
  const stat = lstatOrUndefined(pathlib.join(dir, '.git'));
  if (stat !== undefined) {
    return dir;
  }
  const parent = pathlib.dirname(dir);
  return parent === dir ? undefined : findGitAncestor(parent);
};

const lstatOrUndefined = (path: string): fs.Stats | undefined => {
  try {
    return fs.lstatSync(path);
  } catch {
    return undefined;
  }
};

const readFileOrUndefined = (path: string): string | undefined => {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

const readGitdirPointer = (
  dotGitFile: string,
  worktreeRoot: string,
): string | undefined => {
  const content = readFileOrUndefined(dotGitFile);
  if (content === undefined) {
    return undefined;
  }
  const prefix = 'gitdir: ';
  const line = content.split('\n')[0] ?? '';
  if (!line.startsWith(prefix)) {
    return undefined;
  }
  const pointed = line.slice(prefix.length).trim();
  const resolved = pathlib.isAbsolute(pointed)
    ? pointed
    : pathlib.resolve(worktreeRoot, pointed);
  return realpathOrSelf(resolved);
};

const readMainWorktreeRoot = (gitDir: string): string | undefined => {
  const commondir = readFileOrUndefined(
    pathlib.join(gitDir, 'commondir'),
  )?.trim();
  if (commondir === undefined || commondir === '') {
    return undefined;
  }
  const gitCommon = pathlib.isAbsolute(commondir)
    ? commondir
    : pathlib.resolve(gitDir, commondir);
  const resolved = realpathOrSelf(gitCommon);
  const main = pathlib.dirname(resolved);
  return main === resolved ? undefined : main;
};

const realpathOrSelf = (path: string): string => {
  try {
    return fs.realpathSync(path);
  } catch {
    return path;
  }
};

const hashPath = (path: string): string =>
  createHash('sha256').update(path).digest('hex').slice(0, 16);
