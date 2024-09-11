/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import chokidar from 'chokidar';
import {Analyzer} from './analyzer.js';
import {Cache} from './caching/cache.js';
import {
  ScriptConfig,
  ScriptReference,
  ScriptReferenceString,
  scriptReferenceToString,
} from './config.js';
import {Executor, FailureMode, ServiceMap} from './executor.js';
import {Logger} from './logging/logger.js';
import {Deferred} from './util/deferred.js';
import './util/dispose.js';
import {WorkerPool} from './util/worker-pool.js';

import type {Agent, Options} from './cli-options.js';
import type {Fingerprint} from './fingerprint.js';

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
interface FileWatcher extends AsyncDisposable {
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
  #state: WatcherState = 'initial';

  readonly #rootScript: ScriptReference;
  readonly #extraArgs: string[] | undefined;
  readonly #logger: Logger;
  readonly #workerPool: WorkerPool;
  readonly #cache?: Cache;
  readonly #failureMode: FailureMode;
  readonly #agent: Agent;
  #executor?: Executor;
  #debounceTimeoutId?: NodeJS.Timeout = undefined;
  #previousIterationServices?: ServiceMap = undefined;
  #previousIterationFailures = new Map<ScriptReferenceString, Fingerprint>();

  /**
   * The most recent analysis of the root script. As soon as we detect it might
   * be stale because a package.json file was modified, this becomes undefined
   * again.
   */
  #latestRootScriptConfig?: ScriptConfig;

  /**
   * The file watcher for all package.json files relevant to this build graph.
   */
  #configFilesWatcher?: FileWatcher;

  /**
   * File watchers for the input files of all scripts in this build graph.
   */
  readonly #inputFileWatchers = new Map<ScriptReferenceString, FileWatcher>();

  /**
   * Resolves when this watcher has been aborted and the last run finished.
   */
  readonly #finished = new Deferred<void>();

  readonly #watchOptions: Exclude<Options['watch'], false>;

  constructor(
    rootScript: ScriptReference,
    extraArgs: string[] | undefined,
    logger: Logger,
    workerPool: WorkerPool,
    cache: Cache | undefined,
    failureMode: FailureMode,
    agent: Agent,
    watchOptions: Exclude<Options['watch'], false>,
  ) {
    this.#rootScript = rootScript;
    this.#extraArgs = extraArgs;
    this.#logger = logger.getWatchLogger?.() ?? logger;
    this.#workerPool = workerPool;
    this.#failureMode = failureMode;
    this.#cache = cache;
    this.#agent = agent;
    this.#watchOptions = watchOptions;
  }

  watch(): Promise<void> {
    this.#startRun();
    return this.#finished.promise;
  }

  #startDebounce(): void {
    if (this.#debounceTimeoutId !== undefined) {
      throw new Error('Expected #debounceTimeoutId to be undefined');
    }
    this.#debounceTimeoutId = setTimeout(() => {
      this.#onDebounced();
    }, DEBOUNCE_MS);
  }

  #cancelDebounce(): void {
    clearTimeout(this.#debounceTimeoutId);
    this.#debounceTimeoutId = undefined;
  }

  #onDebounced(): void {
    switch (this.#state) {
      case 'debouncing': {
        this.#debounceTimeoutId = undefined;
        this.#startRun();
        return;
      }
      case 'initial':
      case 'watching':
      case 'queued':
      case 'running':
      case 'aborted': {
        throw unexpectedState(this.#state);
      }
      default: {
        throw unknownState(this.#state);
      }
    }
  }

  #startRun(): void {
    switch (this.#state) {
      case 'initial':
      case 'debouncing': {
        this.#state = 'running';
        this.#logger.log({
          script: this.#rootScript,
          type: 'info',
          detail: 'watch-run-start',
        });
        if (this.#latestRootScriptConfig === undefined) {
          void this.#analyze();
        } else {
          // We already have a valid config, so we can skip the analysis step.
          // but if the logger needs to know about the analysis, this lets
          // it know.
          this.#logger.log({
            type: 'info',
            detail: 'analysis-completed',
            script: this.#rootScript,
            rootScriptConfig: this.#latestRootScriptConfig,
          });
          void this.#execute(this.#latestRootScriptConfig);
        }
        return;
      }
      case 'watching':
      case 'queued':
      case 'running':
      case 'aborted': {
        throw unexpectedState(this.#state);
      }
      default: {
        throw unknownState(this.#state);
      }
    }
  }

  async #analyze(): Promise<void> {
    if (this.#state !== 'running') {
      throw unexpectedState(this.#state);
    }

    const analyzer = new Analyzer(this.#agent, this.#logger);
    const result = await analyzer.analyze(this.#rootScript, this.#extraArgs);
    if ((this.#state as WatcherState) === 'aborted') {
      return;
    }

    // Set up watchers for all relevant config files even if there were errors
    // so that we'll try again when the user modifies a config file.
    const configFiles = [...result.relevantConfigFilePaths];
    // Order doesn't matter because we know we don't have any !negated patterns,
    // but we're going to compare arrays exactly so the order should be
    // deterministic.
    configFiles.sort();
    const oldWatcher = this.#configFilesWatcher;
    if (!watchPathsEqual(configFiles, oldWatcher?.patterns)) {
      this.#configFilesWatcher = makeWatcher(
        configFiles,
        '/',
        this.#onConfigFileChanged,
        true,
        this.#watchOptions,
      );
      if (oldWatcher !== undefined) {
        void oldWatcher[Symbol.asyncDispose]();
      }
    }

    if (!result.config.ok) {
      for (const error of result.config.error) {
        this.#logger.log(error);
      }
      this.#onRunDone();
      return;
    }

    this.#latestRootScriptConfig = result.config.value;
    this.#synchronizeInputFileWatchers(this.#latestRootScriptConfig);
    void this.#execute(this.#latestRootScriptConfig);
  }

  async #execute(script: ScriptConfig): Promise<void> {
    if (this.#state !== 'running') {
      throw unexpectedState(this.#state);
    }
    this.#executor = new Executor(
      script,
      this.#logger,
      this.#workerPool,
      this.#cache,
      this.#failureMode,
      this.#previousIterationServices,
      true,
      this.#previousIterationFailures,
    );
    const result = await this.#executor.execute();
    this.#previousIterationServices = result.persistentServices;
    if (result.errors.length > 0) {
      for (const error of result.errors) {
        this.#logger.log(error);
      }
    } else {
      this.#previousIterationFailures = new Map();
    }
    this.#onRunDone();
  }

  #onRunDone(): void {
    this.#logger.log({
      script: this.#rootScript,
      type: 'info',
      detail: 'watch-run-end',
    });
    switch (this.#state) {
      case 'queued': {
        // Note that the debounce time could actually have already elapsed since
        // the last file change while we were running, but we don't start the
        // debounce timer until the run finishes. This means that the debounce
        // interval is also the minimum time between successive runs. This seems
        // fine and probably good, and is simpler than maintaining a separate
        // "queued-debouncing" state.
        this.#state = 'debouncing';
        this.#startDebounce();
        return;
      }
      case 'running': {
        this.#state = 'watching';
        return;
      }
      case 'aborted': {
        this.#finished.resolve();
        return;
      }
      case 'initial':
      case 'watching':
      case 'debouncing': {
        throw unexpectedState(this.#state);
      }
      default: {
        throw unknownState(this.#state);
      }
    }
  }

  #onConfigFileChanged = (): void => {
    this.#latestRootScriptConfig = undefined;
    this.#fileChanged();
  };

  #fileChanged = (): void => {
    switch (this.#state) {
      case 'watching': {
        this.#state = 'debouncing';
        this.#startDebounce();
        return;
      }
      case 'debouncing': {
        this.#cancelDebounce();
        this.#startDebounce();
        return;
      }
      case 'running': {
        this.#state = 'queued';
        return;
      }
      case 'queued':
      case 'aborted': {
        return;
      }
      case 'initial': {
        throw unexpectedState(this.#state);
      }
      default: {
        throw unknownState(this.#state);
      }
    }
  };

  #synchronizeInputFileWatchers(root: ScriptConfig): void {
    const visited = new Set<ScriptReferenceString>();
    const visit = (script: ScriptConfig) => {
      const key = scriptReferenceToString(script);
      if (visited.has(key)) {
        return;
      }
      visited.add(key);

      const newInputFiles = script.files?.values;
      const oldWatcher = this.#inputFileWatchers.get(key);
      if (!watchPathsEqual(newInputFiles, oldWatcher?.patterns)) {
        if (newInputFiles === undefined || newInputFiles.length === 0) {
          this.#inputFileWatchers.delete(key);
        } else {
          const newWatcher = makeWatcher(
            newInputFiles,
            script.packageDir,
            this.#fileChanged,
            true,
            this.#watchOptions,
          );
          this.#inputFileWatchers.set(key, newWatcher);
        }
        if (oldWatcher !== undefined) {
          void oldWatcher[Symbol.asyncDispose]();
        }
      }
      for (const dep of script.dependencies) {
        visit(dep.config);
      }
    };
    visit(root);

    // There also could be some scripts that have been removed entirely.
    for (const [oldKey, oldWatcher] of this.#inputFileWatchers) {
      if (!visited.has(oldKey)) {
        void oldWatcher[Symbol.asyncDispose]();
        this.#inputFileWatchers.delete(oldKey);
      }
    }
  }

  abort(): void {
    if (this.#executor !== undefined) {
      this.#executor.abort();
      this.#executor = undefined;
    }
    switch (this.#state) {
      case 'debouncing':
      case 'watching': {
        if (this.#state === 'debouncing') {
          this.#cancelDebounce();
        }
        this.#state = 'aborted';
        this.#closeAllFileWatchers();
        this.#finished.resolve();
        return;
      }
      case 'running':
      case 'queued': {
        this.#state = 'aborted';
        this.#closeAllFileWatchers();
        // Don't resolve #finished immediately so that we will wait for #analyze
        // or #execute to finish.
        return;
      }
      case 'aborted': {
        return;
      }
      case 'initial': {
        throw unexpectedState(this.#state);
      }
      default: {
        throw unknownState(this.#state);
      }
    }
  }

  #closeAllFileWatchers() {
    void this.#configFilesWatcher?.[Symbol.asyncDispose]();
    for (const value of this.#inputFileWatchers.values()) {
      void value[Symbol.asyncDispose]();
    }
  }
}

const watchPathsEqual = (
  a: Array<string> | undefined,
  b: Array<string> | undefined,
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

/**
 * Exported for testing.
 *
 * @param ignoreInitial Ignore the initial "add" events emitted when chokidar
 * first discovers each file. We already do an initial run, so these events are
 * just noise that may trigger an unnecessary second run.
 * https://github.com/paulmillr/chokidar#path-filtering
 */
export const makeWatcher = (
  patterns: string[],
  cwd: string,
  callback: () => void,
  ignoreInitial: boolean,
  watchOptions: Exclude<Options['watch'], false>,
): FileWatcher => {
  // TODO(aomarks) chokidar doesn't work exactly like fast-glob, so there are
  // currently various differences in what gets watched vs what actually affects
  // the build. See https://github.com/google/wireit/issues/550.
  const watcher = chokidar.watch(
    // Trim leading slashes from patterns, to "re-root" all paths to the package
    // directory, just as we do when globbing for script execution.
    patterns.map((pattern) => pattern.replace(/^\/+/, '')),
    {
      cwd,
      ignoreInitial,
      usePolling: watchOptions.strategy === 'poll',
      interval:
        watchOptions.strategy === 'poll' ? watchOptions.interval : undefined,
    },
  );
  watcher.on('all', callback);
  return {
    patterns,
    watcher,
    async [Symbol.asyncDispose]() {
      await watcher.close();
    },
  };
};
