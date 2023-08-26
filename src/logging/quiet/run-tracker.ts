/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {inspect} from 'util';
import {
  ScriptConfig,
  ScriptReference,
  ScriptReferenceString,
  scriptReferenceToString,
} from '../../config.js';
import {Failure, Info, Success, Output, Event} from '../../event.js';
import {DefaultLogger, labelForScript} from '../default-logger.js';
import {DEBUG} from '../logger.js';
import {WriteoverLine} from './writeover-line.js';
import {StackMap} from './stack-map.js';

/**
 * State that the run tracker cares about for a currently running script.
 */
class ScriptState {
  readonly outputBuffer: Array<string | Buffer> = [];
  readonly scriptReference: ScriptReference;
  readonly service: boolean;
  readonly isRootScript: boolean;
  constructor(
    scriptReference: ScriptReference,
    service: boolean,
    isRootScript: boolean
  ) {
    this.scriptReference = scriptReference;
    this.service = service;
    this.isRootScript = isRootScript;
  }

  writeOutput(output: Output) {
    if (output.stream === 'stdout') {
      process.stdout.write(output.data);
    } else {
      process.stderr.write(output.data);
    }
  }

  bufferOutput(output: Output) {
    this.outputBuffer.push(output.data);
  }
}

export const noChange = Symbol('nochange');
export const nothing = Symbol('nothing');

type StatusLineResult = string | typeof noChange | typeof nothing;

/**
 *     ┌───────┐
 *     │initial│
 *     └───┬───┘
 *         │
 *    ┌────▼────┐
 *    │analyzing├─────────────┐
 *    └────┬────┘             │
 *         │                  │
 *    ┌────▼────┐          ┌──▼─┐
 *    │executing├──────────►done│
 *    └─────────┘          └────┘
 */
type StatusLineState =
  /**
   * The run has just begun.
   */
  | 'initial'
  /**
   * After analysis has started, but before it has finished.
   */
  | 'analyzing'
  /**
   * Analysis has finished, we're executing the run. We may have encountered
   * some failures, but the run isn't over yet and we're still giving a
   * status line with the spinner.
   */
  | 'executing'
  /**
   * As far as the spinner is concerned, we've reached a terminal state.
   *
   * Maybe the run succeeded. Maybe it failed. Maybe we're now executing the
   * root script and so instead of the spinner we're purely passing through its
   * output. In any case, no more spinner, no more status line.
   */
  | 'done';

/**
 * The info we expect to get from an analysis in order to report progress
 * info.
 */
interface AnalysisInfo {
  readonly rootScript: ScriptReferenceString;
  // The scripts that we need to actually run, including services, scripts
  // we can skip because of freshness / output restoration, etc.
  readonly scriptsWithCommands: ReadonlySet<ScriptReferenceString>;
  // Whether we might need to run services as part of this run.
  readonly hasServices: boolean;
}

/**
 * Tracks the state of a run, and produces a single line of status text.
 *
 * A QuietLogger usually just has one of these, but in --watch mode we use
 * one per iteration.
 */
export class RunTracker {
  /**
   * Currently running scripts, or failed scripts that we're about to
   * report on. A script is added to this when it starts, and removed
   * only when it successfully exits.
   *
   * Keyed by this._getKey
   */
  private readonly _running = new StackMap<
    ScriptReferenceString,
    ScriptState
  >();
  /** The number of commands we've started. */
  private _ran = 0;
  /**
   * The number of scripts with commands that were either fresh or whose output
   * we restored.
   */
  private _skipped = 0;
  private _encounteredFailures = false;
  private _servicesRunning = 0;
  private _servicesStarted = 0;
  private _servicesPersistedFromPreviousRun = 0;
  private _analysisInfo: AnalysisInfo | undefined = undefined;
  private _finishedScriptsWithCommands = new Set<ScriptReferenceString>();
  private _statusLineState: StatusLineState = 'initial';
  private readonly _startTime = Date.now();
  private readonly _rootPackage: string;
  private readonly _defaultLogger: DefaultLogger;
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

  private readonly _scriptsWithAlreadyReportedErrors =
    new Set<ScriptReferenceString>();

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
        instance._markScriptAsFinished(state.scriptReference);
      }
    }
    return instance;
  }

  /**
   * Takes an Event and updates our summary stats for this run.
   *
   * If it returns undefined, the previous message is still good. If it returns
   * null, the message should be cleared entirely.
   */
  getUpdatedMessageAfterEvent(event: Event): StatusLineResult {
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
    this._statusLineState = 'done';
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
      const label = labelForScript(this._rootPackage, state.scriptReference);
      const key = scriptReferenceToString(state.scriptReference);
      if (this._scriptsWithAlreadyReportedErrors.has(key) || state.service) {
        continue;
      }
      // We expected this to finish running, but it didn't. We haven't seen
      // this in our testing, so it's as much of a test of our own code as
      // anything else.
      process.stderr.write(`\n❌ [${label}] did not exit successfully.`);
      this._reportOutputForFailingScript(state.scriptReference);
    }
    if (this._scriptsWithAlreadyReportedErrors.size > 0) {
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
    const state = this._running.get(scriptReferenceToString(script));
    if (!state) {
      throw new Error(
        `Internal error: Got ${
          cause?.reason ? `${cause.reason} event` : 'leftover script'
        } for script without a start event. Events delivered out of order?
    Script with failure: ${scriptReferenceToString(script)}
    Known scripts: ${inspect([...this._running.keys()])}
`
      );
    }
    for (const output of state.outputBuffer) {
      process.stderr.write(output);
    }
    state.outputBuffer.length = 0;
  }

  private _getStatusLine(): StatusLineResult {
    switch (this._statusLineState) {
      case 'initial': {
        return 'Starting';
      }
      case 'analyzing': {
        return 'Analyzing';
      }
      case 'executing': {
        if (this._analysisInfo === undefined) {
          return `??? Internal error: Analysis info missing ???`;
        }
        return this._getExecutionStatusLine(this._analysisInfo);
      }
      case 'done': {
        // No status line now.
        return nothing;
      }
      default: {
        const never: never = this._statusLineState;
        throw new Error(`Unknown status line state: ${JSON.stringify(never)}`);
      }
    }
  }

  private _getExecutionStatusLine(
    analysisInfo: AnalysisInfo
  ): StatusLineResult {
    const peekResult = this._running.peek()?.[1];
    let mostRecentScript = '';
    if (peekResult !== undefined) {
      mostRecentScript = labelForScript(
        this._rootPackage,
        peekResult.scriptReference
      );
    }
    const done = this._finishedScriptsWithCommands.size;
    const total = analysisInfo.scriptsWithCommands.size;
    const percentDone =
      String(Math.round((done / total) * 100)).padStart(3, ' ') + '%';

    let servicesInfo = '';
    if (analysisInfo.hasServices) {
      const s = this._servicesRunning === 1 ? '' : 's';
      servicesInfo = ` [${this._servicesRunning.toLocaleString()} service${s}]`;
    }
    let failureInfo = '';
    if (this._scriptsWithAlreadyReportedErrors.size > 0) {
      failureInfo = ` [${this._scriptsWithAlreadyReportedErrors.size.toLocaleString()} failed]`;
    }
    return `${percentDone} [${done.toLocaleString()} / ${total}] [${
      this._running.size
    } running]${servicesInfo}${failureInfo} ${mostRecentScript}`;
  }

  private _markScriptAsFinished(script: ScriptReference) {
    const key = scriptReferenceToString(script);
    // Almost always, a script that's finished will be one that we intended
    // to execute as part of this run. However there's one exception:
    // if a persistent service was started as part of the previous run, but then
    // we change the package.json files so that we no longer need to run it,
    // it will be shut down as part of _our_ run. In that case, we don't want
    // to count it towards our total.
    const isScriptOfInterest =
      // Optimistically mark it as finished if we don't have analysis info yet.
      // We'll remove it later if we find out it's not actually a script we
      // care about.
      this._analysisInfo === undefined ||
      this._analysisInfo.scriptsWithCommands.has(key);
    if (isScriptOfInterest) {
      this._finishedScriptsWithCommands.add(key);
    }
  }

  private _handleInfo(event: Info): StatusLineResult {
    if (DEBUG) {
      console.log(
        `info: ${event.detail} ${labelForScript(
          this._rootPackage,
          event.script
        )}`
      );
    }
    switch (event.detail) {
      case 'running': {
        const key = scriptReferenceToString(event.script);
        this._running.set(
          key,
          new ScriptState(
            event.script,
            false,
            this._analysisInfo?.rootScript === key
          )
        );
        return this._getStatusLine();
      }
      case 'service-process-started':
        // Services don't end, so we count this as having finished.
        this._servicesRunning++;
        this._servicesStarted++;
        const key = scriptReferenceToString(event.script);
        this._running.set(
          key,
          new ScriptState(
            event.script,
            true,
            this._analysisInfo?.rootScript === key
          )
        );
        this._markScriptAsFinished(event.script);
        return this._getStatusLine();
      case 'service-stopped':
        this._servicesRunning--;
        this._running.delete(scriptReferenceToString(event.script));
        return this._getStatusLine();
      case 'service-ready':
      case 'watch-run-start':
      case 'watch-run-end':
        return noChange;
      case 'locked': {
        // the script is blocked on starting because something else is
        // using a shared resource
        return noChange;
      }
      case 'output-modified': {
        // the script is being run because its output files have changed
        // log nothing
        return noChange;
      }
      case 'cache-info': {
        // chatty event, e.g. transitory GitHub API errors.
        // definitely don't log anything here
        return noChange;
      }
      case 'analysis-started': {
        this._statusLineState = 'analyzing';
        return this._getStatusLine();
      }
      case 'analysis-completed': {
        if (!event.rootScriptConfig) {
          // will report the error in printSummary
          this._statusLineState = 'done';
          return nothing;
        } else {
          this._statusLineState = 'executing';
          this._analysisInfo = this._countScriptsWithCommands(
            event.rootScriptConfig
          );
          for (const finished of this._finishedScriptsWithCommands) {
            if (!this._analysisInfo.scriptsWithCommands.has(finished)) {
              this._finishedScriptsWithCommands.delete(finished);
            }
          }
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
        this._markScriptAsFinished(event.script);
        this._skipped++;
        return this._getStatusLine();
      }
      case 'fresh': {
        this._markScriptAsFinished(event.script);
        this._skipped++;
        return this._getStatusLine();
      }
      case 'exit-zero': {
        this._running.delete(scriptReferenceToString(event.script));
        this._markScriptAsFinished(event.script);
        this._ran++;
        return this._getStatusLine();
      }
      case 'no-command': {
        return noChange;
      }
      default: {
        const never: never = event;
        throw new Error(`Unknown success event: ${JSON.stringify(never)}`);
      }
    }
  }

  private _handleFailure(event: Failure): typeof noChange {
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
    return noChange;
  }

  private _reportFailure(failure: Failure) {
    const key = scriptReferenceToString(failure.script as ScriptReference);
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
        process.stderr.write(`\n❌ [${label}] ${message}.${trailer}\n`);
        if (scriptHadOutput) {
          this._reportOutputForFailingScript(failure.script, failure);
        }
        this._finishedScriptsWithCommands.add(key);
        this._running.delete(key);
        return this._getStatusLine();
      }
      case 'start-cancelled':
      case 'aborted': {
        // These events aren't very useful to log, because they are downstream
        // of failures that already get reported elsewhere.
        this._running.delete(scriptReferenceToString(failure.script));
        return this._getStatusLine();
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
    const state = this._running.get(scriptReferenceToString(script));
    if (!state) {
      throw new Error(
        `Internal error: could not find state for failing script. Events delivered out of order?
        Script with output: ${labelForScript(this._rootPackage, script)}
        ${this._running.size.toLocaleString()} known running scripts: ${inspect(
          [...this._running.keys()]
        )}`
      );
    }
    return state.outputBuffer.some((output) => output.length > 0);
  }

  private _handleOutput(event: Output): StatusLineResult {
    const key = scriptReferenceToString(event.script);
    const state = this._running.get(key);
    if (!state) {
      throw new Error(
        `Internal error: Got output event for unknown script. Events delivered out of order?
        Script with output: ${labelForScript(this._rootPackage, event.script)}
        ${this._running.size.toLocaleString()} known running scripts: ${inspect(
          [...this._running.keys()]
        )}`
      );
    }
    if (state.isRootScript) {
      this._statusLineState = 'done';
      // This is a terminal state, so stop all status lines, from here on out
      // we're going to be just printing the root script's output.
      this._writeoverLine.clearAndStopSpinner();
      state.writeOutput(event);
      return nothing;
    }
    if (state.service) {
      // Pause the status line while we print this real quick, but then resume
      // it.
      const pause = this._writeoverLine.clearUntilDisposed();
      state.writeOutput(event);
      pause?.[Symbol.dispose]();
      return noChange;
    }
    // Buffer everything else so that we can print it
    // (possibly a second time) in case of failure.
    state.outputBuffer.push(event.data);
    return noChange;
  }

  private _countScriptsWithCommands(rootScript: ScriptConfig): AnalysisInfo {
    const scriptsWithCommands = new Set<ScriptReferenceString>();
    let hasServices = false;
    const seen = new Set([scriptReferenceToString(rootScript)]);
    const toVisit = [rootScript];
    while (toVisit.length > 0) {
      const script = toVisit.pop()!;
      if (script.service) {
        hasServices = true;
      }
      if (script.command !== undefined) {
        // We only want to count scripts that actually run, rather than
        // just holding dependencies.
        scriptsWithCommands.add(scriptReferenceToString(script));
      }
      for (const dependency of script.dependencies.values()) {
        const key = scriptReferenceToString(dependency.config);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        toVisit.push(dependency.config);
      }
    }
    return {
      rootScript: scriptReferenceToString(rootScript),
      scriptsWithCommands,
      hasServices,
    };
  }
}
