import {KnownError} from '../shared/known-error.js';
import {readConfig} from '../shared/read-config.js';
import {spawn} from 'child_process';
import * as pathlib from 'path';
import {findNearestPackageJson} from '../shared/nearest-package-json.js';
import fastglob from 'fast-glob';
import {resolveTask} from '../shared/resolve-task.js';
import {statReachablePackageLocks} from '../shared/stat-reachable-package-locks.js';
import {Abort} from '../shared/abort.js';
import {StateManager} from '../shared/state-manager.js';
import {FilesystemCache} from '../shared/filesystem-cache.js';
import * as fs from 'fs/promises';
import {createHash} from 'crypto';

import type {Cache} from '../shared/cache.js';
import type {Config, Task} from '../types/config.js';

export default async (args: string[], abort: Promise<typeof Abort>) => {
  if (args.length !== 1 && process.env.npm_lifecycle_event === undefined) {
    throw new KnownError(
      'invalid-argument',
      `Expected 1 argument but got ${args.length}`
    );
  }

  // We could check process.env.npm_package_json here, but it's actually wrong
  // in some cases. E.g. when we invoke wireit from one npm script, but we're
  // asking it to evaluate another directory.
  const packageJsonPath = await findNearestPackageJson(process.cwd());
  if (packageJsonPath === undefined) {
    throw new KnownError(
      'invalid-argument',
      `Could not find a package.json in ${process.cwd()} or parents`
    );
  }

  // TODO(aomarks) A way to control the file key mode.
  const runner = new TaskRunner(abort, 'content', new FilesystemCache());
  const taskName = args[0] ?? process.env.npm_lifecycle_event;
  await runner.run(packageJsonPath, taskName, new Set());
};

interface TaskStatus {
  cacheKey: CacheKey;
}

interface CacheKey {
  command: string;
  // Must be sorted by filename.
  files: {[filename: string]: FileCacheKey};
  // Must be sorted by taskname.
  dependencies: {[taskname: string]: CacheKey};
  // Must be sorted by filename.
  npmPackageLocks: {[filename: string]: FileCacheKey};
}

type FileCacheKey = FileModKey | FileContentHashKey;

type FileCacheType = FileCacheKey['type'];

interface FileModKey {
  type: 'mod';
  m: number;
  c: number;
}

// TODO(aomarks) What about permission bits?
interface FileContentHashKey {
  type: 'content';
  sha256: string;
}

export class TaskRunner {
  private readonly _configs = new Map<string, Promise<Config>>();
  private readonly _taskPromises = new Map<string, Promise<TaskStatus>>();
  private readonly _abort: Promise<typeof Abort>;
  private readonly _stateManager = new StateManager();
  private readonly _cache: Cache;
  private readonly _fileCacheType: FileCacheType;

  constructor(
    abort: Promise<typeof Abort>,
    fileCacheMode: FileCacheType,
    cache: Cache
  ) {
    this._abort = abort;
    this._fileCacheType = fileCacheMode;
    this._cache = cache;
  }

  /**
   * @returns A promise that resolves to true if the task ran, otherwise false.
   */
  async run(
    packageJsonPath: string,
    taskName: string,
    stack: Set<string>
  ): Promise<TaskStatus> {
    const taskId = JSON.stringify([packageJsonPath, taskName]);
    if (stack.has(taskId)) {
      throw new KnownError(
        'cycle',
        `Cycle detected at task ${taskName} in ${packageJsonPath}`
      );
    }

    let promise = this._taskPromises.get(taskId);
    if (promise !== undefined) {
      return promise;
    }
    let resolve: (value: TaskStatus) => void;
    promise = new Promise<TaskStatus>((r) => (resolve = r));
    this._taskPromises.set(taskId, promise);

    const {config, task} = await this._findConfigAndTask(
      packageJsonPath,
      taskName
    );

    const newCacheKeyData: CacheKey = {
      command: task.command!, // TODO(aomarks) This shouldn't be undefined.
      files: {},
      dependencies: {},
      npmPackageLocks: {},
    };

    if (task.dependencies?.length) {
      // IMPORTANT: We must sort here, because it's important that the insertion
      // order of dependency entries in our cache key is deterministic.
      task.dependencies.sort((a, b) => a.localeCompare(b));

      const depTaskPromises = [];
      for (const depTaskName of task.dependencies) {
        depTaskPromises.push(
          this.run(
            config.packageJsonPath,
            depTaskName,
            new Set(stack).add(taskId)
          )
        );
      }
      // Note we use Promise.allSettled() instead of Promise.all() here because
      // we want don't want our top-level task to throw until all sub-tasks have
      // had a chance to clean up in the case of a failure.
      const results = await Promise.allSettled(depTaskPromises);
      for (let i = 0; i < task.dependencies.length; i++) {
        const depTaskName = task.dependencies[i];
        const result = results[i];
        if (result.status === 'rejected') {
          // TODO(aomarks) Could create a compound error here.
          throw result.reason;
        }
        newCacheKeyData.dependencies[depTaskName] = result.value.cacheKey;
      }
    }

    if (task.files?.length) {
      const entries = await fastglob(task.files, {
        stats: true,
        cwd: pathlib.dirname(config.packageJsonPath),
      });

      // IMPORTANT: We must sort here, because it's important that the insertion
      // order of file entries in our cache key is deterministic.
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        const stats = entry.stats;
        if (stats === undefined) {
          throw new Error(
            `Unexpected internal error. No file stats for ${entry.name}.`
          );
        }
        // TODO(aomarks) Pin down whether entry.name is dealing with relative vs
        // absolute paths correctly.
        if (this._fileCacheType === 'mod') {
          newCacheKeyData.files[entry.name] = {
            type: 'mod',
            m: stats.mtimeMs,
            c: stats.ctimeMs,
          };
        } else {
          const content = await fs.readFile(entry.name, 'utf8');
          const sha256 = createHash('sha256').update(content).digest('hex');
          newCacheKeyData.files[entry.name] = {
            type: 'content',
            sha256,
          };
        }
      }
    }

    if (task.npm ?? true) {
      const packageLocks = await statReachablePackageLocks(
        pathlib.dirname(packageJsonPath)
      );
      newCacheKeyData.npmPackageLocks = Object.fromEntries(
        packageLocks.map(([filename, stat]) => [
          filename,
          // TODO(aomarks) This needs to be content based too.
          {type: 'mod', m: stat.mtimeMs, c: stat.ctimeMs},
        ])
      );
    }

    const newCacheKey = JSON.stringify(newCacheKeyData);
    const oldCacheKey = await this._stateManager.getCacheKey(
      config.packageJsonPath,
      taskName
    );
    const cacheKeyStale =
      oldCacheKey === undefined || newCacheKey !== oldCacheKey;
    if (!cacheKeyStale) {
      resolve!({cacheKey: newCacheKeyData});
      return promise;
    }

    if (task.command) {
      // TODO(aomarks) Output needs to be in the cache key too.
      // TODO(aomarks) We should race against abort here too (any expensive operation).
      const cachedOutput = await this._cache?.getOutputs(
        packageJsonPath,
        taskName,
        newCacheKey
      );
      if (cachedOutput !== undefined) {
        await cachedOutput.apply();
      } else {
        // We run tasks via npx so that PATH will include the node_modules/.bin
        // directory, matching the standard behavior of an NPM script. This also
        // gives access to other NPM-specific environment variables that a user's
        // script might need.
        const child = spawn('npx', ['-c', task.command], {
          cwd: pathlib.dirname(config.packageJsonPath),
          stdio: 'inherit',
          detached: true,
        });
        const completed = new Promise<void>((resolve, reject) => {
          // TODO(aomarks) Do we need to handle "close"? Is there any way a
          // "close" event can be fired, but not an "exit" or "error" event?
          child.on('error', () => {
            reject(
              new KnownError(
                'task-control-error',
                `Command ${taskName} failed to start`
              )
            );
          });
          child.on('exit', (code, signal) => {
            if (signal !== null) {
              reject(
                new KnownError(
                  'task-cancelled',
                  `Command ${taskName} exited with signal ${code}`
                )
              );
            } else if (code !== 0) {
              reject(
                new KnownError(
                  'task-failed',
                  `Command ${taskName} failed with code ${code}`
                )
              );
            } else {
              resolve();
            }
          });
        });
        const result = await Promise.race([completed, this._abort]);
        if (result === Abort) {
          process.kill(-child.pid!, 'SIGINT');
          await completed;
          throw new Error(
            `Unexpected internal error. Task ${taskName} should have thrown.`
          );
        }
        if (this._cache !== undefined) {
          // TODO(aomarks) Shouldn't need to block on this finishing.
          await this._cache.saveOutputs(
            packageJsonPath,
            taskName,
            newCacheKey,
            // TODO(aomarks) Should we be calling the cache with no outputs?
            task.outputs ?? []
          );
        }
      }
    }

    await this._stateManager.setCacheKey(
      config.packageJsonPath,
      taskName,
      newCacheKey
    );

    resolve!({cacheKey: newCacheKeyData});
    return promise;
  }

  private async _findConfigAndTask(
    packageJsonPath: string,
    taskName: string
  ): Promise<{config: Config; task: Task}> {
    const resolved = resolveTask(packageJsonPath, taskName);
    packageJsonPath = resolved.packageJsonPath;
    taskName = resolved.taskName;
    const config = await this._getConfig(packageJsonPath);
    const task = config.tasks?.[taskName];
    if (task === undefined) {
      throw new KnownError(
        'task-not-found',
        `Could not find task ${taskName} in ${packageJsonPath}`
      );
    }
    return {config, task};
  }

  private async _getConfig(packageJsonPath: string): Promise<Config> {
    let promise = this._configs.get(packageJsonPath);
    if (promise === undefined) {
      promise = readConfig(packageJsonPath);
      this._configs.set(packageJsonPath, promise);
    }
    return promise;
  }
}
