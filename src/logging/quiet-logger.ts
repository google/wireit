/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {inspect} from 'util';
import {ScriptConfig, ScriptReference} from '../config.js';
import {Event, Failure, Info, Output, Success} from '../event.js';
import {DefaultLogger, labelForScript} from './default-logger.js';
import {Logger} from './logger.js';

const DEBUG = true;
// ??
{
  type Mutable<T> = {-readonly [P in keyof T]: T[P]};

  // Quick Symbol.dispose polyfill.
  (Symbol as Mutable<typeof Symbol>).dispose =
    Symbol.dispose ?? Symbol('dispose');
}

/**
 * A {@link Logger} that prints less to the console.
 *
 * While running, it prints a single line of status text with information about
 * how the run is progressing. When the run is complete, it prints a one line
 * summary of the results if successful, and logs failures with the
 * corresponding script's stderr/stdout if something went wrong.
 */
export class QuietLogger implements Logger {
  private runTracker;
  private readonly _rootPackage: string;
  private readonly _writeoverLine = new WriteoverLine();

  constructor(rootPackage: string) {
    this._rootPackage = rootPackage;
    this.runTracker = new RunTracker(this._rootPackage, this._writeoverLine);
  }

  printMetrics() {
    this._writeoverLine.clearAndStopSpinner();
    this.runTracker.printSummary();
  }

  log(event: Event): void {
    if (event.type === 'info' && event.detail === 'watch-run-start') {
      this.runTracker = this.runTracker.makeInstanceForNewRun();
    }
    const line = this.runTracker.getUpdatedMessageAfterEvent(event);
    if (line !== undefined) {
      if (line === null) {
        this._writeoverLine.clearAndStopSpinner();
      } else {
        this._writeoverLine.writeLine(line);
      }
    }
    if (event.type === 'info' && event.detail === 'watch-run-end') {
      this.printMetrics();
    }
  }

  getWatchLogger(): Logger {
    return this;
  }
}

class ScriptState {
  readonly output: Array<string | Buffer> = [];
  readonly scriptReference: ScriptReference;
  readonly service: boolean;
  constructor(scriptReference: ScriptReference, service: boolean) {
    this.scriptReference = scriptReference;
    this.service = service;
  }
}

// TODO: remove this once we can add esnext.disposable to tsconfig.json
interface Disposable {
  [Symbol.dispose]: () => void;
}

class Spinner {
  private _frame = 0;
  private _frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  get nextFrame() {
    const frame = this._frames[this._frame];
    this._frame = (this._frame + 1) % this._frames.length;
    return frame;
  }
}

/**
 * Handles displaying a single line of status text, overwriting the previously
 * written line, and displaying a spinner to indicate liveness.
 */
class WriteoverLine {
  private _previousLineLength = 0;
  private _line = '';
  private _spinnerInterval: NodeJS.Timeout | undefined;
  private _spinner = new Spinner();

  consturctor() {
    // If the user does a ctrl-c then we stop the spinner.
    process.on('SIGINT', () => {
      this.clearAndStopSpinner();
    });
  }

  clearAndStopSpinner() {
    // Writeover the previous line and cancel the spinner interval.
    if (this._spinnerInterval !== undefined) {
      clearInterval(this._spinnerInterval);
      this._spinnerInterval = undefined;
    }
    if (this._line !== '') {
      this._line = '';
      this._writeLineAndScrubPrevious('');
    }
  }

  writeLine(line: string) {
    this._line = line;
    if (line === '') {
      // Writeover the previous line and cancel the spinner interval.
      if (this._spinnerInterval !== undefined) {
        clearInterval(this._spinnerInterval);
        this._spinnerInterval = undefined;
      }
      this._writeLineAndScrubPrevious('');
      return;
    }
    if (this._spinnerInterval !== undefined) {
      // will render on next frame
      return;
    }
    // render now, and then schedule future renders.
    this._writeLatestLineWithSpinner();
    // a smooth sixty
    let targetFps = 60;
    // Don't flood the CI log system with spinner frames.
    if (process.env.CI) {
      targetFps = 1 / 5;
    }
    // schedule future renders so the spinner stays going
    this._spinnerInterval = setInterval(() => {
      this._writeLatestLineWithSpinner();
    }, 1000 / targetFps);
  }

  clearUntilDisposed(): Disposable | undefined {
    // already cleared, nothing to do
    if (this._spinnerInterval === undefined) {
      return undefined;
    }
    const line = this._line;
    this.clearAndStopSpinner();
    return {
      [Symbol.dispose]: () => {
        this.writeLine(line);
      },
    };
  }

  private _writeLatestLineWithSpinner() {
    this._writeLineAndScrubPrevious(`${this._spinner.nextFrame} ${this._line}`);
  }

  private _writeLineAndScrubPrevious(line: string) {
    process.stderr.write(line);
    const overflow = this._previousLineLength - line.length;
    if (overflow > 0) {
      process.stderr.write(' '.repeat(overflow));
    }
    if (DEBUG) {
      process.stderr.write('\n');
    } else {
      process.stderr.write('\r');
    }
    this._previousLineLength = line.length;
  }
}

/**
 * A map that can also efficiently return the most recently added entry.
 */
class StackMap<K, V> extends Map<K, V> {
  private _stack: Array<[K, V]> = [];

  override set(key: K, value: V) {
    if (!this.has(key)) {
      this._stack.push([key, value]);
    }
    return super.set(key, value);
  }

  // Surprisingly, we don't need to override delete, because we expect peek()
  // to be called frequently, and it will remove any trailing deleted entries.

  /**
   * Returns the most recently added entry, or undefined if the map is empty.
   */
  peek(): [K, V] | undefined {
    while (true) {
      const last = this._stack[this._stack.length - 1];
      if (!last) {
        return;
      }
      if (this.has(last[0])) {
        return last;
      }
      this._stack.pop();
    }
  }
}

/**
 * The info we expect to get from an analysis in order to report progress
 * info.
 */
interface AnalysisInfo {
  rootScript: string;
  services: number;
  scriptsWithCommands: number;
}

type RunState =
  /**
   * The initial state for a one-time command.
   */
  | 'initial'
  /**
   * After analysis has started, but before it has finished.
   */
  | 'analyzing'
  /**
   * The analysis has failed, and this run is over.
   */
  | 'analysis failed'
  /**
   * Analysis has finished, we're running scripts. Some may have failed.
   */
  | 'running'
  /**
   * We're running the root script, and it's emitting output. We don't want
   * to show a status line in this case, because we want to defer all output
   * to the root script.
   */
  | 'passing through root command output';

/**
 * Tracks the state of a run, and produces a single line of status text.
 *
 * A QuietLogger usually just has one of these, but in --watch mode we use
 * one per iteration.
 */
class RunTracker {
  /**
   * Currently running scripts, or failed scripts that we're about to
   * report on. A script is added to this when it starts, and removed
   * only when it successfully exits.
   *
   * Keyed by this._getKey
   */
  private readonly _running = new StackMap<string, ScriptState>();
  /** The number of commands we've started. */
  private _ran = 0;
  /**
   * The number of scripts with commands that were either fresh or whose output
   * we restored.
   */
  private _skipped = 0;
  /**
   * The number of scripts that finished with errors.
   */
  private _failed = 0;
  private _encounteredFailures = false;
  private _servicesRunning = 0;
  private _servicesStarted = 0;
  private _servicesPersistedFromPreviousRun = 0;
  private _analysisInfo: AnalysisInfo | undefined = undefined;
  private _state: RunState = 'initial';
  private readonly _startTime = Date.now();
  private readonly _rootPackage: string;
  private readonly _defaultLogger: DefaultLogger;
  /**
   * True once the root script of this run (i.e. the script "foo" that the
   * user invoked with "npm run foo") has emitted output to stdout/stderr
   */
  private _rootScriptHasOutput = false;
  private readonly _writeoverLine;
  /**
   * Sometimes a script will fail multiple times, but we only want to report
   * about the first failure for it that we find. Sometimes a script will
   * even end up with multiple failures for the same reason, like multiple
   * non-zero-exit-code events. This looks to be coming at the NodeJS level
   * or above, and so we just cope.
   *
   * Keyed by this._getKey
   */

  private readonly _scriptsWithAlreadyReportedErrors = new Set<string>();

  constructor(
    rootPackage: string,
    _writeoverLine: WriteoverLine,
    defaultLogger?: DefaultLogger
  ) {
    this._rootPackage = rootPackage;
    this._writeoverLine = _writeoverLine;
    this._defaultLogger = defaultLogger ?? new DefaultLogger(rootPackage);
  }

  makeInstanceForNewRun(): RunTracker {
    // Reuse the default logger, a minor savings.
    const instance = new RunTracker(
      this._rootPackage,
      this._writeoverLine,
      this._defaultLogger
    );
    // Persistent services stay running between runs, so pass along what we
    // know.
    for (const [key, state] of this._running) {
      if (state.service) {
        instance._servicesPersistedFromPreviousRun++;
        instance._servicesRunning++;
        instance._running.set(key, state);
      }
    }
    return instance;
  }

  private _getKey(script: ScriptReference) {
    return `${script.packageDir}:${script.name}`;
  }

  /**
   * Takes an Event and updates our summary stats for this run.
   *
   * If it returns undefined, the previous message is still good. If it returns
   * null, the message should be cleared entirely.
   */
  getUpdatedMessageAfterEvent(event: Event): string | undefined | null {
    switch (event.type) {
      case 'success': {
        return this._handleSuccess(event);
      }
      case 'failure': {
        return this._handleFailure(event);
      }
      case 'info': {
        return this._handleInfo(event);
      }
      case 'output': {
        return this._handleOutput(event);
      }
      default: {
        const never: never = event;
        throw new Error(`Unknown event type: ${JSON.stringify(never)}`);
      }
    }
  }

  /**
   * Should be called once, at the end of a run.
   */
  printSummary() {
    let scriptsStillRunning = false;
    for (const state of this._running.values()) {
      if (state.service) {
        continue;
      }
      scriptsStillRunning = true;
    }
    if (this._encounteredFailures || scriptsStillRunning) {
      this._printFailureSummary();
      return;
    }
    this._printSuccessSummary();
  }

  private _printFailureSummary() {
    for (const [, state] of this._running) {
      const key = labelForScript(this._rootPackage, state.scriptReference);
      if (this._scriptsWithAlreadyReportedErrors.has(key) || state.service) {
        continue;
      }
      const label = labelForScript(this._rootPackage, state.scriptReference);
      process.stderr.write(`\n❌ ${label} did not exit successfully.`);
      this._reportOutputForFailingScript(state.scriptReference);
    }
    if (this._failed > 0) {
      const s = this._scriptsWithAlreadyReportedErrors.size === 1 ? '' : 's';
      process.stderr.write(
        `❌ ${this._scriptsWithAlreadyReportedErrors.size.toLocaleString()} script${s} failed.\n`
      );
    } else {
      process.stderr.write(`❌ Failed.\n`);
    }
  }

  private _printSuccessSummary() {
    const elapsed = Math.round((Date.now() - this._startTime) / 100) / 10;
    // In watch mode, we want to count services that we started as part of this
    // run.
    const count = this._ran + this._servicesStarted;
    const s = count === 1 ? '' : 's';
    console.log(
      `✅ Ran ${count.toLocaleString()} script${s} and skipped ${this._skipped.toLocaleString()} in ${elapsed.toLocaleString()}s.`
    );
  }

  private _reportOutputForFailingScript(
    script: ScriptReference,
    cause?: Failure
  ) {
    this._failed++;
    const state = this._running.get(this._getKey(script));
    if (!state) {
      throw new Error(
        `Internal error: Got ${
          cause?.reason ? `${cause.reason} event` : 'leftover script'
        } for script without a start event. Events delivered out of order?
    Script with failure: ${this._getKey(script)}
    Known scripts: ${inspect([...this._running.keys()])}
`
      );
    }
    for (const output of state.output) {
      process.stderr.write(output);
    }
    state.output.length = 0;
  }

  private _getStatusLine(): string | null {
    switch (this._state) {
      case 'initial': {
        return 'Starting';
      }
      case 'analyzing': {
        return 'Analyzing';
      }
      case 'running': {
        if (this._analysisInfo === undefined) {
          return `??? Internal error: Analysis info missing ???`;
        }
        const peekResult = this._running.peek()?.[1];
        let mostRecentScript = '';
        if (peekResult !== undefined) {
          mostRecentScript = labelForScript(
            this._rootPackage,
            peekResult.scriptReference
          );
        }
        if (
          this._running.size === 1 &&
          peekResult !== undefined &&
          this._analysisInfo.rootScript ===
            this._getKey(peekResult.scriptReference) &&
          this._rootScriptHasOutput
        ) {
          // Ok, we're running the root script and nothing else, and the
          // root script isn't silent. In that case we just want to
          // defer all output to it rather than showing a status line.
          return null;
        }
        const done =
          this._ran +
          this._skipped +
          this._failed +
          this._servicesStarted +
          this._servicesPersistedFromPreviousRun;
        const total =
          this._analysisInfo.scriptsWithCommands + this._analysisInfo.services;
        if (done === total) {
          // We're apparently done, so don't show a status line or a spinner.
          // We can stay in this state for a while and get more events if
          // we have services running.
          return null;
        }
        const percentDone =
          String(Math.round((done / total) * 100)).padStart(3, ' ') + '%';

        let servicesInfo = '';
        if (this._analysisInfo.services > 0) {
          const s = this._servicesRunning === 1 ? '' : 's';
          servicesInfo = ` [${this._servicesRunning.toLocaleString()} service${s}]`;
        }
        let failureInfo = '';
        if (this._failed > 0) {
          failureInfo = ` [${this._failed.toLocaleString()} failed]`;
        }
        // console.log(this);
        return `${percentDone} [${done.toLocaleString()} / ${total}] [${
          this._running.size
        } running]${servicesInfo}${failureInfo} ${mostRecentScript}`;
      }
      case 'analysis failed':
      case 'passing through root command output': {
        // No status line in these cases
        return null;
      }
      default: {
        const never: never = this._state;
        throw new Error(`Unknown state: ${JSON.stringify(never)}`);
      }
    }
  }

  private _handleInfo(event: Info): string | undefined | null {
    if (DEBUG) {
      console.log(
        `success: ${event.detail} ${labelForScript(
          this._rootPackage,
          event.script
        )}`
      );
    }
    switch (event.detail) {
      case 'running': {
        this._running.set(
          this._getKey(event.script),
          new ScriptState(event.script, false)
        );
        return this._getStatusLine();
      }
      case 'service-process-started':
        // Services don't end, so we count this as having finished.
        this._servicesRunning++;
        this._servicesStarted++;
        this._running.set(
          this._getKey(event.script),
          new ScriptState(event.script, true)
        );
        return this._getStatusLine();
      case 'service-stopped':
        this._servicesRunning--;
        this._running.delete(this._getKey(event.script));
        return this._getStatusLine();
      case 'service-started':
      case 'watch-run-start':
      case 'watch-run-end':
        return;
      case 'locked': {
        // the script is blocked on starting because something else is
        // using a shared resource
        // log nothing
        return;
      }
      case 'output-modified': {
        // the script is being run because its output files have changed
        // log nothing
        return;
      }
      case 'generic': {
        // chatty event, e.g. transitory GitHub API errors.
        // definitely don't log anything here
        return;
      }
      case 'analysis-started': {
        this._state = 'analyzing';
        return this._getStatusLine();
      }
      case 'analysis-completed': {
        if (!event.rootScriptConfig) {
          // will report the error in printSummary
          this._state = 'analysis failed';
          return this._getStatusLine();
        } else {
          this._state = 'running';
          this._analysisInfo = this._countScriptsWithCommands(
            event.rootScriptConfig
          );
        }
        return this._getStatusLine();
      }
      default: {
        const never: never = event;
        throw new Error(`Unknown info event: ${JSON.stringify(never)}`);
      }
    }
  }

  private _handleSuccess(event: Success) {
    if (DEBUG) {
      console.log(
        `success: ${event.reason} ${labelForScript(
          this._rootPackage,
          event.script
        )}`
      );
    }
    switch (event.reason) {
      case 'cached': {
        this._skipped++;
        return this._getStatusLine();
      }
      case 'fresh': {
        this._skipped++;
        return this._getStatusLine();
      }
      case 'exit-zero': {
        this._running.delete(this._getKey(event.script));
        this._ran++;
        return this._getStatusLine();
      }
      case 'no-command': {
        return;
      }
      default: {
        const never: never = event;
        throw new Error(`Unknown success event: ${JSON.stringify(never)}`);
      }
    }
  }

  private _handleFailure(event: Failure): undefined {
    if (DEBUG) {
      console.log(
        `failure: ${event.reason} ${labelForScript(
          this._rootPackage,
          event.script
        )}`
      );
    }
    this._encounteredFailures = true;
    {
      // TODO: switch to the 'using' syntax, once prettier and eslint support it
      const pause = this._writeoverLine.clearUntilDisposed();
      this._reportFailure(event);
      pause?.[Symbol.dispose]();
    }
    return;
  }

  private _reportFailure(failure: Failure) {
    const key = labelForScript(this._rootPackage, failure.script);
    if (this._scriptsWithAlreadyReportedErrors.has(key)) {
      return;
    }
    this._scriptsWithAlreadyReportedErrors.add(key);
    const label = labelForScript(this._rootPackage, failure.script);
    switch (failure.reason) {
      case 'exit-non-zero':
      case 'signal':
      case 'killed': {
        let message;
        if (failure.reason === 'exit-non-zero') {
          message = `exited with exit code ${failure.status}`;
        } else if (failure.reason === 'signal') {
          message = `was killed by signal ${failure.signal}`;
        } else {
          message = `killed`;
        }
        const scriptHadOutput = this._scriptHadOutput(failure.script);
        const trailer = scriptHadOutput ? ' Output:\n' : '';
        process.stderr.write(`\n❌ ${label} ${message}.${trailer}\n`);
        this._failed++;
        if (scriptHadOutput) {
          this._reportOutputForFailingScript(failure.script, failure);
        }
        break;
      }
      case 'start-cancelled':
      case 'aborted': {
        // These events aren't very useful to log, because they are downstream
        // of failures that already get reported elsewhere.
        this._running.delete(this._getKey(failure.script));
        break;
      }
      case 'dependency-service-exited-unexpectedly': {
        // Also logged elswhere.
        break;
      }
      case 'service-exited-unexpectedly':
      case 'cycle':
      case 'dependency-invalid':
      case 'dependency-on-missing-package-json':
      case 'dependency-on-missing-script':
      case 'duplicate-dependency':
      case 'failed-previous-watch-iteration':
      case 'invalid-config-syntax':
      case 'invalid-json-syntax':
      case 'invalid-usage':
      case 'launched-incorrectly':
      case 'missing-package-json':
      case 'no-scripts-in-package-json':
      case 'script-not-found':
      case 'script-not-wireit':
      case 'spawn-error':
      case 'unknown-error-thrown':
      case 'wireit-config-but-no-script':
        // The default log for these is good.
        this._defaultLogger.log(failure);
        break;
      default: {
        const never: never = failure;
        throw new Error(`Unknown failure event: ${JSON.stringify(never)}`);
      }
    }
  }

  private _scriptHadOutput(script: ScriptReference): boolean {
    const state = this._running.get(this._getKey(script));
    if (!state) {
      throw new Error(
        `Internal error: could not find state for failing script. Events delivered out of order?
        Script with output: ${this._getKey(script)}
        ${this._running.size.toLocaleString()} known running scripts: ${inspect(
          [...this._running.keys()]
        )}`
      );
    }
    return state.output.some((output) => output.length > 0);
  }

  private _handleOutput(event: Output): string | null | undefined {
    if (DEBUG) {
      console.log(
        `output: ${event.stream} ${labelForScript(
          this._rootPackage,
          event.script
        )}`
      );
    }
    switch (event.stream) {
      case 'stdout':
      case 'stderr': {
        const key = this._getKey(event.script);
        const state = this._running.get(key);
        if (!state) {
          throw new Error(
            `Internal error: Got output event for unknown script. Events delivered out of order?
        Script with output: ${this._getKey(event.script)}
        ${this._running.size.toLocaleString()} known running scripts: ${inspect(
              [...this._running.keys()]
            )}`
          );
        }
        // Immediately pass along output from the script we're trying to run.
        if (state.service || key === this._analysisInfo?.rootScript) {
          this._rootScriptHasOutput = true;
          this._writeoverLine.clearAndStopSpinner();
          this._state = 'passing through root command output';
          process.stderr.write(event.data);
          return null;
        }
        if (!state.service) {
          // Also buffer all non-service output, so that we can print it
          // (possibly a second time) in case of failure.
          state.output.push(event.data);
        }
        return;
      }
      default: {
        const never: never = event;
        throw new Error(`Unknown output event: ${JSON.stringify(never)}`);
      }
    }
  }

  private _countScriptsWithCommands(rootScript: ScriptConfig): AnalysisInfo {
    let scriptsWithCommands = 0;
    let services = 0;
    const seen = new Set([this._getKey(rootScript)]);
    const toVisit = [rootScript];
    while (toVisit.length > 0) {
      const script = toVisit.pop()!;
      if (script.service) {
        services++;
      } else if (script.command !== undefined) {
        // We only want to count scripts that actually run, rather than
        // just holding dependencies.
        scriptsWithCommands++;
      }
      for (const dependency of script.dependencies.values()) {
        const key = this._getKey(dependency.config);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        toVisit.push(dependency.config);
      }
    }
    return {
      rootScript: this._getKey(rootScript),
      services,
      scriptsWithCommands,
    };
  }
}
