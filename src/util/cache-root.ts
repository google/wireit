/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from './fs.js';
import * as pathlib from 'path';

export interface WorktreeInfo {
  worktreeRoot: string;
  mainWorktreeRoot: string;
}

/**
 * Directory whose `.wireit/` folder should hold this package's local cache
 * (not lock/fingerprint/manifest).
 *
 * Linked git worktrees share the main worktree only when `shareWorktrees` is
 * true. Otherwise `packageDir` (Wireit's historical layout). A package also
 * keeps its own cache until the main worktree has the package.
 */
export const resolveCachePackageDir = async (
  packageDir: string,
  options?: {shareWorktrees?: boolean},
): Promise<string> => {
  if (options?.shareWorktrees !== true) {
    return packageDir;
  }
  const absPackageDir = pathlib.resolve(packageDir);
  const worktree = await detectWorktree(absPackageDir);
  if (
    worktree === undefined ||
    worktree.worktreeRoot === worktree.mainWorktreeRoot
  ) {
    return absPackageDir;
  }
  const mainPackageDir = pathlib.join(
    worktree.mainWorktreeRoot,
    pathlib.relative(worktree.worktreeRoot, absPackageDir),
  );
  // Share only when the main worktree has this package. Otherwise Wireit would
  // create the package's folder in the main worktree. This happens for a
  // package that only this worktree's branch has.
  const mainPackageJson = pathlib.join(mainPackageDir, 'package.json');
  if ((await lstatOrUndefined(mainPackageJson)) === undefined) {
    return absPackageDir;
  }
  return mainPackageDir;
};

export const detectWorktree = async (
  startDir: string,
): Promise<WorktreeInfo | undefined> => {
  const worktreeRoot = await findGitAncestor(pathlib.resolve(startDir));
  if (worktreeRoot === undefined) {
    return undefined;
  }
  const dotGit = pathlib.join(worktreeRoot, '.git');
  const stat = await lstatOrUndefined(dotGit);
  if (stat === undefined) {
    return undefined;
  }
  if (stat.isDirectory()) {
    return {worktreeRoot, mainWorktreeRoot: worktreeRoot};
  }
  if (!stat.isFile()) {
    return undefined;
  }
  const gitDir = await readGitdirPointer(dotGit, worktreeRoot);
  if (gitDir === undefined) {
    return undefined;
  }
  const mainWorktreeRoot = await readMainWorktreeRoot(gitDir);
  if (mainWorktreeRoot === undefined) {
    return undefined;
  }
  return {worktreeRoot, mainWorktreeRoot};
};

const findGitAncestor = async (dir: string): Promise<string | undefined> => {
  // Nearest `.git`. A submodule working tree has its own `.git` file, so a
  // package inside one does not walk up into the superproject.
  // https://git-scm.com/docs/gitsubmodules
  const stat = await lstatOrUndefined(pathlib.join(dir, '.git'));
  if (stat !== undefined) {
    return dir;
  }
  const parent = pathlib.dirname(dir);
  return parent === dir ? undefined : findGitAncestor(parent);
};

const lstatOrUndefined = async (
  path: string,
): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> => {
  try {
    return await fs.lstat(path);
  } catch (error) {
    const {code} = error as {code: string};
    if (code === /* does not exist */ 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};

const readFileOrUndefined = async (
  path: string,
): Promise<string | undefined> => {
  try {
    return await fs.readFile(path, 'utf8');
  } catch (error) {
    const {code} = error as {code: string};
    if (code === /* does not exist */ 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};

const readGitdirPointer = async (
  dotGitFile: string,
  worktreeRoot: string,
): Promise<string | undefined> => {
  const content = await readFileOrUndefined(dotGitFile);
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

const readMainWorktreeRoot = async (
  gitDir: string,
): Promise<string | undefined> => {
  // Linked worktrees point `commondir` at the main git dir. A submodule git
  // dir has none, so this returns undefined and the cache stays put.
  // https://git-scm.com/docs/gitrepository-layout
  const commondir = (
    await readFileOrUndefined(pathlib.join(gitDir, 'commondir'))
  )?.trim();
  if (commondir === undefined || commondir === '') {
    return undefined;
  }
  const gitCommon = pathlib.isAbsolute(commondir)
    ? commondir
    : pathlib.resolve(gitDir, commondir);
  const resolved = await realpathOrSelf(gitCommon);
  if (
    !isSupportedSharedCacheLayout(
      await readFileOrUndefined(pathlib.join(resolved, 'config')),
      resolved,
    )
  ) {
    return undefined;
  }
  const main = pathlib.dirname(resolved);
  return main === resolved ? undefined : main;
};

/**
 * Whether the shared git dir's parent is a checkout, making
 * `<parent of git dir>/<package>/.wireit` a safe cache location. Check the
 * config first because bare and submodule git dirs usually aren't named
 * `.git` either.
 *
 * - Bare clone worktrees: the shared config sets `core.bare = true`, so the
 *   parent of the bare dir isn't a checkout.
 * - Worktrees of a submodule: the shared config sets `core.worktree`, so the
 *   parent is the outer repo's git folder.
 * - `git clone --separate-git-dir`: git only names the main git dir `.git`
 *   when it sits inside the checkout, so any other name means its parent
 *   isn't a checkout.
 */
const isSupportedSharedCacheLayout = (
  gitConfig: string | undefined,
  gitCommon: string,
): boolean => {
  if (gitConfig !== undefined) {
    const core = parseGitCoreConfig(gitConfig);
    if (core.bare === true || core.worktree !== undefined) {
      return false;
    }
  }
  return pathlib.basename(gitCommon) === '.git';
};

/** The `[core]` section's `bare` and `worktree` settings, if set. */
const parseGitCoreConfig = (
  gitConfig: string,
): {bare?: boolean; worktree?: string} => {
  const result: {bare?: boolean; worktree?: string} = {};
  let inCore = false;
  for (const line of gitConfig.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inCore = /^\[\s*core\s*[\]]/i.test(trimmed);
      continue;
    }
    if (!inCore) {
      continue;
    }
    const match = /^([^=;#]+?)\s*=\s*(.*?)\s*$/.exec(trimmed);
    if (match === null) {
      continue;
    }
    const key = match[1]!.trim().toLowerCase();
    const value = match[2]!.trim();
    if (key === 'bare') {
      result.bare = /^(true|yes|on|1)$/i.test(value);
    } else if (key === 'worktree') {
      result.worktree = value;
    }
  }
  return result;
};

const realpathOrSelf = async (path: string): Promise<string> => {
  try {
    return await fs.realpath(path);
  } catch (error) {
    const {code} = error as {code: string};
    if (code === /* does not exist */ 'ENOENT') {
      return path;
    }
    throw error;
  }
};
