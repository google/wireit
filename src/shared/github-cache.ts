import fastglob from 'fast-glob';
import * as pathlib from 'path';
import {createHash} from 'crypto';
import * as cache from '@actions/cache';

import type {Cache} from './cache.js';

export class GitHubCache implements Cache {
  async getOutputs(
    packageJsonPath: string,
    taskName: string,
    cacheKey: string,
    taskOutputGlobs: string[]
  ): Promise<GitHubCachedOutput | undefined> {
    console.log(taskName, 6);
    if (taskOutputGlobs.length === 0) {
      console.log(taskName, 6.1);
      // Cache API requires at least one path.
      return undefined;
    }
    console.log(taskName, 6.2);
    const packageRoot = pathlib.dirname(packageJsonPath);
    console.log(taskName, 6.3);
    const paths = await fastglob(taskOutputGlobs, {
      cwd: packageRoot,
      absolute: true,
    });
    console.log(taskName, 6.4);
    // TODO(aomarks) Is packageJsonPath reliable?
    const key = `${packageJsonPath}:${taskName}:${hashCacheKey(cacheKey)}`;
    // TODO(aomarks) @actions/cache doesn't let us just test for a cache hit, so
    // we apply immediately and the output object is a no-op. The underlying
    // library does. But what we really want is a separate manifest cache item
    // that we can apply to a virtual fielsystem.
    console.log(taskName, 6.45, {key, paths, cache});
    let id;
    try {
      id = await cache.restoreCache(paths, key);
    } catch (err) {
      console.log('RESTORE CACHE ERROR', taskName, err);
      throw err;
    }
    console.log(taskName, 6.5);
    if (id !== undefined) {
      console.log('CACHE HIT', {taskName, key, id});
      return new GitHubCachedOutput();
    } else {
      console.log('CACHE MISS', {taskName, key, id});
    }
  }

  async saveOutputs(
    packageJsonPath: string,
    taskName: string,
    cacheKey: string,
    taskOutputGlobs: string[]
  ): Promise<void> {
    if (taskOutputGlobs.length === 0) {
      // Cache API requires at least one path.
      return undefined;
    }
    const packageRoot = pathlib.dirname(packageJsonPath);
    const paths = await fastglob(taskOutputGlobs, {
      cwd: packageRoot,
      absolute: true,
    });
    // TODO(aomarks) Is packageJsonPath reliable?
    const key = `${packageJsonPath}:${taskName}:${hashCacheKey(cacheKey)}`;
    console.log('SAVING CACHE', {taskName, key});
    await cache.saveCache(paths, key);
  }
}

const hashCacheKey = (key: string): string =>
  createHash('sha256').update(key).digest('hex');

class GitHubCachedOutput {
  async apply(): Promise<void> {}
}
