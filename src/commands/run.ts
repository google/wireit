import {KnownError} from '../shared/known-error.js';
import {readConfig} from '../shared/read-config.js';
import {exec as execCallback} from 'child_process';
import {promisify} from 'util';
import * as pathlib from 'path';
import {findNearestPackageJson} from '../shared/nearest-package-json.js';
import fastglob from 'fast-glob';
import {readState, writeState} from '../shared/read-write-state.js';
import {resolveTask} from '../shared/resolve-task.js';

import type {Config, Task} from '../types/config.js';
import type {State} from '../types/state.js';

const exec = promisify(execCallback);

export default async (args: string[]) => {
  if (args.length !== 1 && process.env.npm_lifecycle_event === undefined) {
    throw new KnownError(`Expected 1 argument but got ${args.length}`);
  }

  const packageJsonPath =
    process.env.npm_package_json ??
    (await findNearestPackageJson(process.cwd()));
  if (packageJsonPath === undefined) {
    throw new KnownError(
      `Could not find a package.json in ${process.cwd()} or parents`
    );
  }

  const runner = new TaskRunner();
  const taskName = args[0] ?? process.env.npm_lifecycle_event;
  await runner.run(packageJsonPath, taskName, new Set());
  await runner.writeStates();
};

export class TaskRunner {
  private readonly _configs = new Map<string, Promise<Config>>();
  private readonly _taskPromises = new Map<string, Promise<boolean>>();
  private readonly _states = new Map<string, Promise<State>>();

  /**
   * @returns A promise that resolves to true if the task ran, otherwise false.
   */
  async run(
    packageJsonPath: string,
    taskName: string,
    stack: Set<string>
  ): Promise<boolean> {
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
    let resolve: (value: boolean) => void;
    promise = new Promise<boolean>((r) => (resolve = r));
    this._taskPromises.set(taskId, promise);

    const {config, task} = await this._findConfigAndTask(
      packageJsonPath,
      taskName
    );

    let anyDepTasksRan = false;
    if (task.dependencies?.length) {
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
      anyDepTasksRan = results.some((ran) => ran === true);
    }

    let fileCacheKey = '';
    if (task.files?.length) {
      const entries = await fastglob(task.files, {
        stats: true,
        cwd: pathlib.dirname(config.packageJsonPath),
      });
      let maxModTime = 0;
      for (const entry of entries) {
        const stats = entry.stats!;
        maxModTime = Math.max(maxModTime, stats.mtimeMs, stats.ctimeMs);
      }
      const numFiles = entries.length;
      fileCacheKey = `${maxModTime}:${numFiles}`;
    }

    const newCacheKey = JSON.stringify({
      command: task.command,
      files: fileCacheKey,
    });

    const state = await this._getState(pathlib.dirname(config.packageJsonPath));
    const oldCacheKey = state.cacheKeys[taskName];
    const cacheKeyStale =
      oldCacheKey === undefined || newCacheKey !== oldCacheKey;
    if (cacheKeyStale) {
      state.cacheKeys[taskName] = newCacheKey;
    }
    if (!cacheKeyStale && !anyDepTasksRan) {
      resolve!(false);
      return promise;
    }
    if (task.command) {
      console.log('Running task', taskId);
      // TODO(aomarks) Something better with stdout/stderr.
      // TODO(aomarks) Use npx
      const {stdout, stderr} = await exec(task.command, {
        cwd: pathlib.dirname(config.packageJsonPath),
      });
      console.log(stdout);
      console.log(stderr);
    }
    resolve!(true);
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
