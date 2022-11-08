/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import chokidar from 'chokidar';
import {Analyzer} from './analyzer.js';
import {Cache} from './caching/cache.js';
import {Executor, FailureMode, ServiceMap} from './executor.js';
import {Logger} from './logging/logger.js';
import {Deferred} from './util/deferred.js';
import {WorkerPool} from './util/worker-pool.js';
import {
  ScriptConfig,
  ScriptReference,
  ScriptReferenceString,
  scriptReferenceToString,
} from './config.js';

/**
 * ```
 *                                                            ┌─────────┐
 *                                                            │ initial │
 *                                                            └────┬────┘
 *                                                                 │
 *       ╭────────────◄────────── RUN_DONE ────────◄────────────╮  │
 *       │                                                      │  │
 *       │                    FILE_CHANGED  ╭─────────◄─────────│──│─────◄─── RUN_DONE ────◄───╮
 *       │                          │ ▲     │                   │  │                           │
 *  ┌────▼─────┐                  ┌─▼─┴─────▼──┐              ┌─┴──▼────┐                  ┌───┴────┐
 *  │ watching ├── FILE_CHANGED ──► debouncing ├─ DEBOUNCED ──► running ├── FILE_CHANGED ──► queued │
 *  └────┬─────┘                  └─────┬──────┘              └────┬────┘                  └───┬────┘
 *       │                              │                          │                           │
 *     ABORT                          ABORT                      ABORT                       ABORT
 *       │                              ╰───────────╮   ╭──────────╯                           │
 *       ▼                                       ┌──▼───▼──┐                                   ▼
 *       ╰────────────────────►──────────────────► aborted ◄─────────────────◄─────────────────╯
 *                                               └─────────┘
 * ```
 */
type WatcherState =
  | 'initial'
  | 'watching'
  | 'debouncing'
  | 'running'
  | 'queued'
  | 'aborted';

function unknownState(state: never) {
  return new Error(`Unknown watcher state ${String(state)}`);
}

function unexpectedState(state: WatcherState) {
  return new Error(`Unexpected watcher state ${state}`);
}

/**
 * A chokidar file watcher along with the file patterns it was configured to
 * watch.
 */
interface FileWatcher {
  patterns: string[];
  watcher: chokidar.FSWatcher;
}

/**
 * The minimum time that must elapse after the last file change was detected
 * before we begin a new run. Also the minimum time between successive runs.
 *
 * Note even 0 is a useful value here, because that defers new runs to the next
 * JS task. This is important because if multiple scripts are watching the same
 * file that changed, we get a file watcher event for each of them. Without
 * debouncing, a second run will be immediately queued after the first event
 * starts the run.
 */
const DEBOUNCE_MS = 0;

/**
 * Watches a script for changes in its input files, and in the input files of
 * its transitive dependencies, and executes all affected scripts when they
 * change.
 *
 * Also watches all related package.json files and reloads script configuration
 * when they change.
 */
export class Watcher {
  /** See {@link WatcherState} */
  private _state: WatcherState = 'initial';

  private readonly _rootScript: ScriptReference;
  private readonly _extraArgs: string[] | undefined;
  private readonly _logger: Logger;
  private readonly _workerPool: WorkerPool;
  private readonly _cache?: Cache;
  private readonly _failureMode: FailureMode;
  private _executor?: Executor;
  private _debounceTimeoutId?: NodeJS.Timeout = undefined;
  private _previousIterationServices?: ServiceMap = undefined;

  /**
   * The most recent analysis of the root script. As soon as we detect it might
   * be stale because a package.json file was modified, this becomes undefined
   * again.
   */
  private _latestRootScriptConfig?: ScriptConfig;

  /**
   * The file watcher for all package.json files relevant to this build graph.
   */
  private _configFilesWatcher?: FileWatcher;

  /**
   * File watchers for the input files of all scripts in this build graph.
   */
  private readonly _inputFileWatchers = new Map<
    ScriptReferenceString,
    FileWatcher
  >();

  /**
   * Resolves when this watcher has been aborted and the last run finished.
   */
  private readonly _finished = new Deferred<void>();

  constructor(
    rootScript: ScriptReference,
    extraArgs: string[] | undefined,
    logger: Logger,
    workerPool: WorkerPool,
    cache: Cache | undefined,
    failureMode: FailureMode
  ) {
    this._rootScript = rootScript;
    this._extraArgs = extraArgs;
    this._logger = logger;
    this._workerPool = workerPool;
    this._failureMode = failureMode;
    this._cache = cache;
  }

  watch(): Promise<void> {
    void this._startRun();
    return this._finished.promise;
  }

  private _startDebounce(): void {
    if (this._debounceTimeoutId !== undefined) {
      throw new Error('Expected #debounceTimeoutId to be undefined');
    }
    this._debounceTimeoutId = setTimeout(() => {
      this._onDebounced();
    }, DEBOUNCE_MS);
  }

  private _cancelDebounce(): void {
    clearTimeout(this._debounceTimeoutId);
    this._debounceTimeoutId = undefined;
  }

  private _onDebounced(): void {
    switch (this._state) {
      case 'debouncing': {
        this._debounceTimeoutId = undefined;
        this._startRun();
        return;
      }
      case 'initial':
      case 'watching':
      case 'queued':
      case 'running':
      case 'aborted': {
        throw unexpectedState(this._state);
      }
      default: {
        throw unknownState(this._state);
      }
    }
  }

  private _startRun(): void {
    switch (this._state) {
      case 'initial':
      case 'debouncing': {
        this._state = 'running';
        this._logger.log({
          script: this._rootScript,
          type: 'info',
          detail: 'watch-run-start',
        });
        if (this._latestRootScriptConfig === undefined) {
          void this._analyze();
        } else {
          void this._execute(this._latestRootScriptConfig);
        }
        return;
      }
      case 'watching':
      case 'queued':
      case 'running':
      case 'aborted': {
        throw unexpectedState(this._state);
      }
      default: {
        throw unknownState(this._state);
      }
    }
  }

  private async _analyze(): Promise<void> {
    if (this._state !== 'running') {
      throw unexpectedState(this._state);
    }

    const analyzer = new Analyzer();
    const result = await analyzer.analyze(this._rootScript, this._extraArgs);
    if ((this._state as WatcherState) === 'aborted') {
      return;
    }

    // Set up watchers for all relevant config files even if there were errors
    // so that we'll try again when the user modifies a config file.
    const configFiles = [...result.relevantConfigFilePaths];
    // Order doesn't matter because we know we don't have any !negated patterns,
    // but we're going to compare arrays exactly so the order should be
    // deterministic.
    configFiles.sort();
    const oldWatcher = this._configFilesWatcher;
    if (!watchPathsEqual(configFiles, oldWatcher?.patterns)) {
      this._configFilesWatcher = makeWatcher(
        configFiles,
        '/',
        this._onConfigFileChanged
      );
      if (oldWatcher !== undefined) {
        void oldWatcher.watcher.close();
      }
    }

    if (!result.config.ok) {
      for (const error of result.config.error) {
        this._logger.log(error);
      }
      this._onRunDone();
      return;
    }

    this._latestRootScriptConfig = result.config.value;
    this._synchronizeInputFileWatchers(this._latestRootScriptConfig);
    void this._execute(this._latestRootScriptConfig);
  }

  private async _execute(script: ScriptConfig): Promise<void> {
    if (this._state !== 'running') {
      throw unexpectedState(this._state);
    }
    this._executor = new Executor(
      script,
      this._logger,
      this._workerPool,
      this._cache,
      this._failureMode,
      this._previousIterationServices,
      true
    );
    const result = await this._executor.execute();
    if (result.ok) {
      this._previousIterationServices = result.value;
    } else {
      this._previousIterationServices = undefined;
      for (const error of result.error) {
        this._logger.log(error);
      }
    }
    this._onRunDone();
  }

  private _onRunDone(): void {
    this._logger.log({
      script: this._rootScript,
      type: 'info',
      detail: 'watch-run-end',
    });
    switch (this._state) {
      case 'queued': {
        // Note that the debounce time could actually have already elapsed since
        // the last file change while we were running, but we don't start the
        // debounce timer until the run finishes. This means that the debounce
        // interval is also the minimum time between successive runs. This seems
        // fine and probably good, and is simpler than maintaining a separate
        // "queued-debouncing" state.
        this._state = 'debouncing';
        void this._startDebounce();
        return;
      }
      case 'running': {
        this._state = 'watching';
        return;
      }
      case 'aborted': {
        this._finished.resolve();
        return;
      }
      case 'initial':
      case 'watching':
      case 'debouncing': {
        throw unexpectedState(this._state);
      }
      default: {
        throw unknownState(this._state);
      }
    }
  }

  private _onConfigFileChanged = (): void => {
    this._latestRootScriptConfig = undefined;
    this._fileChanged();
  };

  private _fileChanged = (): void => {
    switch (this._state) {
      case 'watching': {
        this._state = 'debouncing';
        void this._startDebounce();
        return;
      }
      case 'debouncing': {
        void this._cancelDebounce();
        void this._startDebounce();
        return;
      }
      case 'running': {
        this._state = 'queued';
        return;
      }
      case 'queued':
      case 'aborted': {
        return;
      }
      case 'initial': {
        throw unexpectedState(this._state);
      }
      default: {
        throw unknownState(this._state);
      }
    }
  };

  private _synchronizeInputFileWatchers(root: ScriptConfig): void {
    const visited = new Set<ScriptReferenceString>();
    const visit = (script: ScriptConfig) => {
      const key = scriptReferenceToString(script);
      if (visited.has(key)) {
        return;
      }
      visited.add(key);

      const newInputFiles = script.files?.values;
      const oldWatcher = this._inputFileWatchers.get(key);
      if (!watchPathsEqual(newInputFiles, oldWatcher?.patterns)) {
        if (newInputFiles === undefined || newInputFiles.length === 0) {
          this._inputFileWatchers.delete(key);
        } else {
          const newWatcher = makeWatcher(
            newInputFiles,
            script.packageDir,
            this._fileChanged
          );
          this._inputFileWatchers.set(key, newWatcher);
        }
        if (oldWatcher !== undefined) {
          void oldWatcher.watcher.close();
        }
      }
      for (const dep of script.dependencies) {
        visit(dep.config);
      }
    };
    visit(root);

    // There also could be some scripts that have been removed entirely.
    for (const [oldKey, oldWatcher] of this._inputFileWatchers) {
      if (!visited.has(oldKey)) {
        void oldWatcher.watcher.close();
        this._inputFileWatchers.delete(oldKey);
      }
    }
  }

  abort(): void {
    if (this._executor !== undefined) {
      this._executor.abort();
      this._executor = undefined;
    }
    switch (this._state) {
      case 'debouncing':
      case 'watching': {
        if (this._state === 'debouncing') {
          this._cancelDebounce();
        }
        this._state = 'aborted';
        this._closeAllFileWatchers();
        this._finished.resolve();
        return;
      }
      case 'running':
      case 'queued': {
        this._state = 'aborted';
        this._closeAllFileWatchers();
        // Don't resolve #finished immediately so that we will wait for #analyze
        // or #execute to finish.
        return;
      }
      case 'aborted': {
        return;
      }
      case 'initial': {
        throw unexpectedState(this._state);
      }
      default: {
        throw unknownState(this._state);
      }
    }
  }

  private _closeAllFileWatchers() {
    void this._configFilesWatcher?.watcher.close();
    for (const value of this._inputFileWatchers.values()) {
      void value.watcher.close();
    }
  }
}

const watchPathsEqual = (
  a: Array<string> | undefined,
  b: Array<string> | undefined
) => {
  if (a === undefined && b === undefined) {
    return true;
  }
  if (a === undefined || b === undefined) {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
};

const makeWatcher = (
  patterns: string[],
  cwd: string,
  callback: () => void
): FileWatcher => {
  const watcher = chokidar.watch(patterns, {
    cwd,
    // Ignore the initial "add" events emitted when chokidar first discovers
    // each file. We already do an initial run, so these events are just noise
    // that may trigger an unnecessary second run.
    // https://github.com/paulmillr/chokidar#path-filtering
    ignoreInitial: true,
  });
  watcher.on('all', callback);
  return {
    patterns,
    watcher,
  };
};
