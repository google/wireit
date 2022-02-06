import {KnownError} from '../shared/known-error.js';
import {readConfig} from '../shared/read-config.js';
import {spawn} from 'child_process';
import * as pathlib from 'path';
import {findNearestPackageJson} from '../shared/nearest-package-json.js';
import fastglob from 'fast-glob';
import {resolveTask} from '../shared/resolve-task.js';
import {hashReachablePackageLocks} from '../shared/hash-reachable-package-locks.js';
import {Abort} from '../shared/abort.js';
import {FilesystemCache} from '../shared/filesystem-cache.js';
import {GitHubCache} from '../shared/github-cache.js';
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

  const cache = process.env.GITHUB_CACHE
    ? new GitHubCache()
    : new FilesystemCache();
  const runner = new TaskRunner(abort, cache);
  const taskName = args[0] ?? process.env.npm_lifecycle_event;
  await runner.run(packageJsonPath, taskName, new Set());
};

interface TaskStatus {
  cacheKey: CacheKey;
}

interface CacheKey {
  command: string;
  // Must be sorted by filename.
  files: {[filename: string]: FileContentHash};
  // Must be sorted by taskname.
  dependencies: {[taskname: string]: CacheKey};
  // Must be sorted by filename.
  npmPackageLocks: {[filename: string]: FileContentHash};
}

// TODO(aomarks) What about permission bits?
interface FileContentHash {
  sha256: string;
}

export class TaskRunner {
  private readonly _configs = new Map<string, Promise<Config>>();
  private readonly _taskPromises = new Map<string, Promise<TaskStatus>>();
  private readonly _abort: Promise<typeof Abort>;
  private readonly _cache: Cache;

  constructor(abort: Promise<typeof Abort>, cache: Cache) {
    this._abort = abort;
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
    console.log('RUN', taskName);
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

    console.log(0);

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

    console.log(taskName, 1);

    if (task.files?.length) {
      const entries = await fastglob(task.files, {
        cwd: pathlib.dirname(config.packageJsonPath),
      });
      console.log(taskName, 2);

      // IMPORTANT: We must sort here, because it's important that the insertion
      // order of file entries in our cache key is deterministic.
      entries.sort((a, b) => a.localeCompare(b));

      const fileHashPromises: Array<Promise<string>> = [];
      for (const entry of entries) {
        // TODO(aomarks) A test case to confirm that we are reading from the
        // right directory (it passed a test, but failed in reality).
        fileHashPromises.push(
          fs
            .readFile(
              pathlib.resolve(pathlib.dirname(packageJsonPath), entry),
              'utf8'
            )
            .then((content) =>
              createHash('sha256').update(content).digest('hex')
            )
        );
      }
      const fileHashes = await Promise.all(fileHashPromises);
      console.log(taskName, 3);

      for (let i = 0; i < entries.length; i++) {
        newCacheKeyData.files[entries[i]] = {
          sha256: fileHashes[i],
        };
      }
    }

    if (task.npm ?? true) {
      const packageLockHashes = await hashReachablePackageLocks(
        pathlib.dirname(packageJsonPath)
      );
      console.log(taskName, 4);

      newCacheKeyData.npmPackageLocks = Object.fromEntries(
        packageLockHashes.map(([filename, sha256]) => [filename, {sha256}])
      );
    }

    const newCacheKey = JSON.stringify(newCacheKeyData);
    const existingFsCacheKey = await this._readCurrentState(
      config.packageJsonPath,
      taskName
    );
    console.log(taskName, 5);

    const cacheKeyStale = newCacheKey !== existingFsCacheKey;
    if (!cacheKeyStale) {
      console.log(`🔌 [${taskName}] Already up to date`);
      resolve!({cacheKey: newCacheKeyData});
      return promise;
    }

    if (task.command) {
      console.log(taskName, 5.1);
      // TODO(aomarks) Output needs to be in the cache key too.
      // TODO(aomarks) We should race against abort here too (any expensive operation).
      // TODO(aomarks) What should we be doing when there is a cache but a task has no outputs? What about empty array outputs vs undefined?
      let cachedOutput;
      if (this._cache !== undefined) {
        cachedOutput = await this._cache.getOutputs(
          packageJsonPath,
          taskName,
          newCacheKey,
          task.outputs ?? []
        );
        console.log(taskName, 6);
      }
      if (cachedOutput !== undefined) {
        console.log(`🔌 [${taskName}] Restoring from cache`);
        await cachedOutput.apply();
        console.log(taskName, 7);
      } else {
        console.log(`🔌 [${taskName}] Running command`);
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
          console.log(`🔌 [${taskName}] Killing`);
          process.kill(-child.pid!, 'SIGINT');
          await completed;
          throw new Error(
            `Unexpected internal error. Task ${taskName} should have thrown.`
          );
        }
        console.log(`🔌 [${taskName}] Completed`);
        if (this._cache !== undefined) {
          // TODO(aomarks) Shouldn't need to block on this finishing.
          await this._cache.saveOutputs(
            packageJsonPath,
            taskName,
            newCacheKey,
            task.outputs ?? []
          );
        }
      }
    }

    await this._writeCurrentState(
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

  private async _readCurrentState(
    packageJsonPath: string,
    taskName: string
  ): Promise<string | undefined> {
    const stateFile = pathlib.resolve(
      pathlib.dirname(packageJsonPath),
      '.wireit',
      'state',
      taskName
    );
    try {
      return await fs.readFile(stateFile, 'utf8');
    } catch (err) {
      if ((err as {code?: string}).code === 'ENOENT') {
        return undefined;
      }
      throw err;
    }
  }

  private async _writeCurrentState(
    packageJsonPath: string,
    taskName: string,
    state: string
  ): Promise<void> {
    const stateFile = pathlib.resolve(
      pathlib.dirname(packageJsonPath),
      '.wireit',
      'state',
      taskName
    );
    await fs.mkdir(pathlib.dirname(stateFile), {recursive: true});
    return fs.writeFile(stateFile, state, 'utf8');
  }
}
