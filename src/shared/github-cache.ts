import {createHash} from 'crypto';
import * as cache from '@actions/cache';
import * as pathlib from 'path';
import {expandGlobCurlyGroups, changeGlobDirectory} from './rewrite-glob.js';

import type {Cache} from './cache.js';

export class GitHubCache implements Cache {
  async getOutput(
    packageJsonPath: string,
    scriptName: string,
    cacheKey: string,
    scriptOutputGlobs: string[]
  ): Promise<GitHubCachedOutput | undefined> {
    if (scriptOutputGlobs.length === 0) {
      scriptOutputGlobs = [fakeFilenameForScriptWithNoOutput(packageJsonPath)];
    }
    scriptOutputGlobs = normalizeGlobsForGitHubCaching(
      scriptOutputGlobs,
      packageJsonPath
    );
    // TODO(aomarks)
    // https://github.com/actions/toolkit/blob/15e23998268e31520e3d93cbd106bd3228dea77f/packages/cache/src/cache.ts#L32
    // key can't have commas or be > 512 characters.
    // TODO(aomarks) Is packageJsonPath reliable?
    const key = `${packageJsonPath}:${scriptName}:${hashCacheKey(cacheKey)}`;
    // TODO(aomarks) @actions/cache doesn't let us just test for a cache hit, so
    // we apply immediately and the output object is a no-op. The underlying
    // library does. But what we really want is a separate manifest cache item
    // that we can apply to a virtual fielsystem.
    let id;
    try {
      id = await cache.restoreCache(scriptOutputGlobs, key);
    } catch (err) {
      throw err;
    }
    if (id !== undefined) {
      console.log(`🐱 [${scriptName}] Restored from GitHub cache`);
      return new GitHubCachedOutput();
    }
  }

  async saveOutput(
    packageJsonPath: string,
    scriptName: string,
    cacheKey: string,
    scriptOutputGlobs: string[]
  ): Promise<void> {
    if (scriptOutputGlobs.length === 0) {
      scriptOutputGlobs = [fakeFilenameForScriptWithNoOutput(packageJsonPath)];
    }
    scriptOutputGlobs = normalizeGlobsForGitHubCaching(
      scriptOutputGlobs,
      packageJsonPath
    );
    // TODO(aomarks) Is packageJsonPath reliable?
    const key = `${packageJsonPath}:${scriptName}:${hashCacheKey(cacheKey)}`;
    console.log(`🐱 [${scriptName}] Saving to GitHub cache`);
    // TODO(aomarks) How can we be sure that the GitHub globbing library matches
    // our one?
    await cache.saveCache(scriptOutputGlobs, key);
    console.log(`🐱 [${scriptName}] Saved to GitHub cache`);
  }
}

/**
 * Rewrite the given globs to be compatible with the GitHub caching library. It
 * doesn't support `a.{x,y}` style curly groups, so we need to expand those. It
 * also doesn't take a cwd, so we need to rewrite the globs to be absolute to
 * the package directory from which they were defined.
 */
const normalizeGlobsForGitHubCaching = (
  globs: string[],
  packageJsonPath: string
): string[] => {
  const packageDir = pathlib.dirname(packageJsonPath);
  const normalized = [];
  for (const glob of globs) {
    for (const expanded of expandGlobCurlyGroups(glob)) {
      normalized.push(changeGlobDirectory(expanded, packageDir));
    }
  }
  return normalized;
};

/**
 * @actions/cache throws if we don't provide at least one filepath. However, it
 * doesn't actually matter whether or not it matches a file on disk.
 *
 * We _do_ want to cache tasks that have no output, because the cache hit alone
 * serves as a useful signal that the task ran successfully with the exact input
 * state, meaning we can skip it.
 *
 * Use an arbitrary path, but put it inside the .wireit directory so that we
 * can't somehow accidentally match a real file.
 */
const fakeFilenameForScriptWithNoOutput = (packageJsonPath: string) =>
  //  TODO(aomarks) Validate it will actually save and restore an empty tarball.
  pathlib.join(
    pathlib.dirname(packageJsonPath),
    '.wireit',
    `fake-file-for-script-with-no-output`
  );

const hashCacheKey = (key: string): string =>
  createHash('sha256').update(key).digest('hex');

class GitHubCachedOutput {
  async apply(): Promise<void> {}
}
