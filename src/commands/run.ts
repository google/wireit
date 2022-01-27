import {KnownError} from '../shared/known-error.js';
import {readConfig} from '../shared/read-config.js';
import {spawn} from 'child_process';
import * as pathlib from 'path';
import {findNearestPackageJson} from '../shared/nearest-package-json.js';
import fastglob from 'fast-glob';
import {readState, writeState} from '../shared/read-write-state.js';
import {resolveTask} from '../shared/resolve-task.js';

import type {Config, Task} from '../types/config.js';
import type {State} from '../types/state.js';

export class CommandFailedError extends Error {}

export default async (args: string[]) => {
  if (args.length !== 1 && process.env.npm_lifecycle_event === undefined) {
    throw new KnownError(`Expected 1 argument but got ${args.length}`);
  }

  // We could check process.env.npm_package_json here, but it's actually wrong
  // in some cases. E.g. when we invoke wireit from one npm script, but we're
  // asking it to evaluate another directory.
  const packageJsonPath = await findNearestPackageJson(process.cwd());
  if (packageJsonPath === undefined) {
    throw new KnownError(
      `Could not find a package.json in ${process.cwd()} or parents`
    );
  }

  const runner = new TaskRunner();
  const taskName = args[0] ?? process.env.npm_lifecycle_event;
  await runner.run(packageJsonPath, taskName, new Set());
  // TODO(aomarks) Maybe we should write states more frequently so that as long
  // as a step actually finished, even a kill -9 wouldn't prevent caching.
  await runner.writeStates();
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
}

// TODO(aomarks) Add FileHashKey
type FileCacheKey = FileModKey;

interface FileModKey {
  type: 'mod';
  m: number;
  c: number;
}

export class TaskRunner {
  private readonly _configs = new Map<string, Promise<Config>>();
  private readonly _taskPromises = new Map<string, Promise<TaskStatus>>();
  private readonly _states = new Map<string, Promise<State>>();

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
      const results = await Promise.all(depTaskPromises);
      for (let i = 0; i < task.dependencies.length; i++) {
        const depTaskName = task.dependencies[i];
        const result = results[i];
        newCacheKeyData.dependencies[depTaskName] = result.cacheKey;
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
          throw new Error(`No file stats for ${entry.name}`);
        }
        // TODO(aomarks) Pin down whether entry.name is dealing with relative vs
        // absolute paths correctly.
        newCacheKeyData.files[entry.name] = {
          type: 'mod',
          m: stats.mtimeMs,
          c: stats.ctimeMs,
        };
      }
    }

    const newCacheKey = JSON.stringify(newCacheKeyData);
    const state = await this._getState(pathlib.dirname(config.packageJsonPath));
    const oldCacheKey = state.cacheKeys[taskName];
    const cacheKeyStale =
      oldCacheKey === undefined || newCacheKey !== oldCacheKey;
    if (cacheKeyStale) {
      state.cacheKeys[taskName] = newCacheKey;
    }
    if (!cacheKeyStale) {
      console.log(`Task ${taskName} already fresh`);
      resolve!({cacheKey: newCacheKeyData});
      return promise;
    }
    if (task.command) {
      // We run tasks via npx so that PATH will include the node_modules/.bin
      // directory, matching the standard behavior of an NPM script. This also
      // gives access to other NPM-specific environment variables that a user's
      // script might need.
      const child = spawn('npx', ['-c', task.command], {
        cwd: pathlib.dirname(config.packageJsonPath),
        stdio: 'inherit',
      });
      await new Promise<void>((resolve, reject) => {
        child.on('close', (code) => {
          if (code !== 0) {
            reject(
              new CommandFailedError(
                `Command ${taskName} failed with code ${code}`
              )
            );
          } else {
            resolve();
          }
        });
      });
    }
    resolve!({cacheKey: newCacheKeyData});
    return promise;
  }

  async writeStates(): Promise<void> {
    const promises = [];
    for (const [root, statePromise] of this._states.entries()) {
      promises.push(statePromise.then((state) => writeState(root, state)));
    }
    await Promise.all(promises);
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

  private async _getState(root: string): Promise<State> {
    let promise = this._states.get(root);
    if (promise === undefined) {
      promise = readState(root).then((state) =>
        state === undefined ? {cacheKeys: {}} : state
      );
      this._states.set(root, promise);
    }
    return promise;
  }
}
