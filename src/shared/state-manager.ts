import type {State} from '../types/state.js';
import {readState, writeState} from './read-write-state.js';
import * as pathlib from 'path';

type QueueItem = {
  packageJsonPath: string;
  taskName: string;
  cacheKey: string;
  resolve: () => void;
};

export class StateManager {
  private readonly _packageStates = new Map<string, Promise<State>>();
  // TODO(aomarks) Is this overly complicated? What if we wrote each task's
  // cache key to its own filename? Then there couldn't be contention within a
  // single wireit process, becuase each task can only run once per run.
  private readonly _writeQueue: Array<QueueItem> = [];
  private _queueIsFlushing = false;

  async getCacheKey(
    packageJsonPath: string,
    taskName: string
  ): Promise<string | undefined> {
    const packageState = await this._getPackageState(packageJsonPath);
    return packageState.cacheKeys[taskName];
  }

  async setCacheKey(
    packageJsonPath: string,
    taskName: string,
    cacheKey: string
  ): Promise<void> {
    const packageState = await this._getPackageState(packageJsonPath);
    const oldCacheKey = packageState.cacheKeys[taskName];
    if (cacheKey !== oldCacheKey) {
      return new Promise((resolve) => {
        this._writeQueue.push({packageJsonPath, taskName, cacheKey, resolve});
        this._flushQueue();
      });
    }
  }

  private async _getPackageState(packageJsonPath: string): Promise<State> {
    let packageStatePromise = this._packageStates.get(packageJsonPath);
    if (packageStatePromise === undefined) {
      packageStatePromise = readState(pathlib.dirname(packageJsonPath)).then(
        (state) => state ?? {cacheKeys: {}}
      );
      this._packageStates.set(packageJsonPath, packageStatePromise);
    }
    return packageStatePromise;
  }

  private async _flushQueue() {
    if (this._queueIsFlushing) {
      return;
    }
    this._queueIsFlushing = true;
    while (this._writeQueue.length > 0) {
      const item = this._writeQueue.shift()!;
      const packageState = await this._getPackageState(item.packageJsonPath);
      packageState.cacheKeys[item.taskName] = item.cacheKey;
      await writeState(pathlib.dirname(item.packageJsonPath), packageState);
      item.resolve();
    }
    this._queueIsFlushing = false;
  }
}
