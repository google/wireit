import fastglob from 'fast-glob';
import * as pathlib from 'path';
import {createHash} from 'crypto';
import * as cache from '@actions/cache';

import type {Cache} from './cache.js';

export class GitHubCache implements Cache {
  async getOutput(
    packageJsonPath: string,
    scriptName: string,
    cacheKey: string,
    scriptOutputGlobs: string[]
  ): Promise<GitHubCachedOutput | undefined> {
    if (scriptOutputGlobs.length === 0) {
      // Cache API requires at least one path.
      // return undefined;
      // TODO(aomarks) Temporary hack
      scriptOutputGlobs = ['README.md'];
    }
    const packageRoot = pathlib.dirname(packageJsonPath);
    const paths = await fastglob(scriptOutputGlobs, {
      cwd: packageRoot,
      absolute: true,
    });
    // TODO(aomarks) Is packageJsonPath reliable?
    const key = `${packageJsonPath}:${scriptName}:${hashCacheKey(cacheKey)}`;
    // TODO(aomarks) @actions/cache doesn't let us just test for a cache hit, so
    // we apply immediately and the output object is a no-op. The underlying
    // library does. But what we really want is a separate manifest cache item
    // that we can apply to a virtual fielsystem.
    let id;
    try {
      id = await cache.restoreCache(paths, key);
    } catch (err) {
      throw err;
    }
    if (id !== undefined) {
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
      // Cache API requires at least one path.
      // return undefined;
      // TODO(aomarks) Temporary hack
      scriptOutputGlobs = ['README.md'];
    }
    const packageRoot = pathlib.dirname(packageJsonPath);
    const paths = await fastglob(scriptOutputGlobs, {
      cwd: packageRoot,
      absolute: true,
    });
    // TODO(aomarks) Is packageJsonPath reliable?
    const key = `${packageJsonPath}:${scriptName}:${hashCacheKey(cacheKey)}`;
    console.log(`🔌 [${scriptName}] Saving to GitHub cache`);
    await cache.saveCache(paths, key);
  }
}

const hashCacheKey = (key: string): string =>
  createHash('sha256').update(key).digest('hex');

class GitHubCachedOutput {
  async apply(): Promise<void> {}
}
