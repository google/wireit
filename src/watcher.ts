/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import chokidar from 'chokidar';
import * as pathlib from 'path';
import {Analyzer} from './analyzer.js';
import {Executor} from './executor.js';
import {Deferred} from './util/deferred.js';
import {scriptReferenceToString} from './script.js';
import {WireitError} from './error.js';

import type {Logger} from './logging/logger.js';
import type {
  ScriptConfig,
  ScriptReference,
  ScriptReferenceString,
} from './script.js';

/**
 * Watches a script for changes in its input files, and in the input files of
 * its transitive dependencies, and executes all affected scripts when they
 * change.
 *
 * Also watches all related package.json files and reloads script configuration
 * when they change.
 */
export class Watcher {
  private readonly _script: ScriptReference;
  private readonly _logger: Logger;
  private readonly _watchers: Array<chokidar.FSWatcher> = [];

  /** Whether an executor is currently running. */
  private _executing = false;

  /** Whether a file has changed since the last time we executed. */
  private _stale = true;

  /** Whether the watcher has been aborted. */
  private _aborted = false;

  /** Notification that some state has changed. */
  private _update = new Deferred<void>();

  constructor(script: ScriptReference, logger: Logger, abort: Promise<void>) {
    this._script = script;
    this._logger = logger;

    // The abort promise never throws.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    abort.then(() => {
      // TODO(aomarks) Aborting should also cause the analyzer and executors to
      // stop if they are running. Currently we only stop after the current
      // build entirely finishes.
      this._aborted = true;
      this._update.resolve();
    });
  }

  /**
   * Execute the script, and continue executing it every time a file related to
   * the configured script changes.
   *
   * @returns When the configured abort promise resolves.
   * @throws If an unexpected error occurs during analysis or execution.
   */
  async watch(): Promise<void> {
    try {
      while (!this._aborted) {
        if (this._stale && !this._executing) {
          await this._analyzeAndExecute();
        }
        await this._update.promise;
        this._update = new Deferred();
      }
    } finally {
      // It's important to close all chokidar watchers, because they will
      // prevent the Node program from ever exiting as long as they are active.
      await this._clearWatchers();
    }
  }

  /**
   * Perform an analysis and execution.
   */
  private async _analyzeAndExecute(): Promise<void> {
    // Reset _stale before execution, not after, because a file could change
    // during execution, and we must not clobber that.
    this._stale = false;
    this._executing = true;

    // TODO(aomarks) We only need to reset watchers and re-analyze if a
    // package.json file changed.
    const analyzer = new Analyzer();

    // TODO(aomarks) Add support for recovering from analysis errors. We'll need
    // to track the package.json files that we encountered, and watch them.
    const analysis = await analyzer.analyze(this._script);
    await this._clearWatchers();
    for (const watchGroup of this._getWatchPathGroups(analysis)) {
      this._watchPaths(watchGroup);
    }

    try {
      const executor = new Executor(this._logger);
      await executor.execute(analysis);
    } catch (error) {
      this._triageErrors(error);
    }
    this._executing = false;
    this._update.resolve();
  }

  /**
   * Handle errors from analysis or execution.
   *
   * Known errors are logged and ignored. They are recoverable because the user
   * can update the config or input files and we'll try again.
   *
   * Other errors throw, aborting the watch process, because they indicate a bug
   * in Wireit, so we can no longer trust the state of the program.
   */
  private _triageErrors(error: unknown): void {
    const errors = error instanceof AggregateError ? error.errors : [error];
    const unexpected = [];
    for (const error of errors) {
      if (error instanceof WireitError) {
        this._logger.log(error.event);
      } else {
        unexpected.push(error);
      }
    }
    if (unexpected.length > 0) {
      if (unexpected.length === 1) {
        throw unexpected[0];
      }
      throw new AggregateError(unexpected);
    }
  }

  /**
   * Start watching the given absolute filesystem paths.
   */
  private _watchPaths(paths: string[]): void {
    const watcher = chokidar.watch(paths);
    this._watchers.push(watcher);
    watcher.on('change', this._fileChanged);
  }

  /**
   * One of the paths we are watching has changed.
   */
  private readonly _fileChanged = (): void => {
    // TODO(aomarks) Cache package JSONS, globs, and hashes.
    this._stale = true;
    this._update.resolve();
  };

  /**
   * Shut down all active file watchers and clear the list.
   */
  private async _clearWatchers(): Promise<void> {
    const watchers = this._watchers.splice(0, this._watchers.length);
    await Promise.all(watchers.map((watcher) => watcher.close()));
  }

  /**
   * Walk through a script config and return a list of absolute filesystem paths
   * that we should watch for changes.
   */
  private _getWatchPathGroups(script: ScriptConfig): Array<string[]> {
    const packageJsons = new Set<string>();
    const groups: Array<string[]> = [];
    const visited = new Set<ScriptReferenceString>();

    const visit = (script: ScriptConfig) => {
      const key = scriptReferenceToString(script);
      if (visited.has(key)) {
        return;
      }
      visited.add(key);
      packageJsons.add(pathlib.join(script.packageDir, 'package.json'));
      if (script.files !== undefined) {
        groups.push(
          script.files.map((file) => pathlib.join(script.packageDir, file))
        );
      }
      for (const dependency of script.dependencies) {
        visit(dependency);
      }
    };

    visit(script);
    groups.push([...packageJsons]);
    return groups;
  }
}
