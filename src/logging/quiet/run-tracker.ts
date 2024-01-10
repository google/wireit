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
import {Console} from '../logger.js';
import {DEBUG} from '../logger.js';
import {StatusLineWriter} from './writeover-line.js';
import {StackMap} from './stack-map.js';

// To prevent using the global console accidentally, we shadow it with
// undefined
const console = undefined;
function markAsUsed(_: unknown) {}
markAsUsed(console);

interface SimpleOutput {
  readonly stream: 'stdout' | 'stderr';
  readonly data: string | Buffer;
}

/**
 * State that the run tracker cares about for a currently running script.
 */
class ScriptState {
  readonly #outputBuffer: Array<SimpleOutput> = [];
  readonly scriptReference: ScriptReference;
  readonly service: boolean;
  readonly isRootScript: boolean;
  constructor(
    scriptReference: ScriptReference,
    service: boolean,
    isRootScript: boolean,
  ) {
    this.scriptReference = scriptReference;
    this.service = service;
    this.isRootScript = isRootScript;
  }

  bufferOutput(output: Output) {
    if (output.data.length === 0) {
      return;
    }
    this.#outputBuffer.push({
      stream: output.stream,
      data: output.data,
    });
  }

  replayAndEmptyBuffer() {
    for (const output of this.#outputBuffer) {
      if (output.stream === 'stdout') {
        process.stdout.write(output.data);
      } else {
        process.stderr.write(output.data);
      }
    }
    this.#outputBuffer.length = 0;
  }

  get hasBufferedOutput(): boolean {
    return this.#outputBuffer.length > 0;
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
export class QuietRunLogger implements Disposable {
  /**
   * Currently running scripts, or failed scripts that we're about to
   * report on. A script is added to this when it starts, and removed
   * only when it successfully exits.
   *
   * Keyed by this._getKey
   */
  readonly #running = new StackMap<ScriptReferenceString, ScriptState>();
  /** The number of commands we've started. */
  #ran = 0;
  /**
   * The number of scripts with commands that were either fresh or whose output
   * we restored.
   */
  #skipped = 0;
  #encounteredFailures = false;
  #servicesRunning = 0;
  #servicesStarted = 0;
  #servicesPersistedFromPreviousRun = 0;
  #analysisInfo: AnalysisInfo | undefined = undefined;
  #finishedScriptsWithCommands = new Set<ScriptReferenceString>();
  #statusLineState: StatusLineState = 'initial';
  readonly #startTime = Date.now();
  readonly #rootPackage: string;
  readonly #defaultLogger: DefaultLogger;
  readonly #statusLineWriter;
  readonly console: Console;
  /**
   * Sometimes a script will fail multiple times, but we only want to report
   * about the first failure for it that we find. Sometimes a script will
   * even end up with multiple failures for the same reason, like multiple
   * non-zero-exit-code events. This looks to be coming at the NodeJS level
   * or above, and so we just cope.
   */
  readonly #scriptsWithAlreadyReportedError = new Set<ScriptReferenceString>();

  constructor(
    rootPackage: string,
    statusLineWriter: StatusLineWriter,
    console: Console,
    defaultLogger?: DefaultLogger,
  ) {
    this.#rootPackage = rootPackage;
    this.#statusLineWriter = statusLineWriter;
    this.#defaultLogger =
      defaultLogger ?? new DefaultLogger(rootPackage, console);
    this.console = console;
  }

  /**
   * Used to make a new instance, keeping info about persistent services
   * that continue from the previous run to the next.
   */
  makeInstanceForNextWatchRun(): QuietRunLogger {
    // Reuse the default logger, a minor savings.
    const instance = new QuietRunLogger(
      this.#rootPackage,
      this.#statusLineWriter,
      this.console,
      this.#defaultLogger,
    );
    // Persistent services stay running between runs, so pass along what we
    // know.
    for (const [key, state] of this.#running) {
      if (state.service) {
        instance.#servicesPersistedFromPreviousRun++;
        instance.#servicesRunning++;
        instance.#running.set(key, state);
        instance.#markScriptAsFinished(state.scriptReference);
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
        return this.#handleSuccess(event);
      }
      case 'failure': {
        return this.#handleFailure(event);
      }
      case 'info': {
        return this.#handleInfo(event);
      }
      case 'output': {
        return this.#handleOutput(event);
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
    this.#statusLineState = 'done';
    let scriptsStillRunning = false;
    for (const state of this.#running.values()) {
      if (state.service) {
        continue;
      }
      scriptsStillRunning = true;
    }
    if (this.#encounteredFailures || scriptsStillRunning) {
      this.#printFailureSummary();
      return;
    }
    this.#printSuccessSummary();
  }

  #printFailureSummary() {
    for (const [, state] of this.#running) {
      const label = labelForScript(this.#rootPackage, state.scriptReference);
      const key = scriptReferenceToString(state.scriptReference);
      if (this.#scriptsWithAlreadyReportedError.has(key) || state.service) {
        continue;
      }
      // We expected this to finish running, but it didn't. We haven't seen
      // this in our testing, so it's as much of a test of our own code as
      // anything else.
      process.stderr.write(`\n❌ [${label}] did not exit successfully.`);
      this.#reportOutputForFailingScript(state.scriptReference);
    }
    if (this.#scriptsWithAlreadyReportedError.size > 0) {
      const s = this.#scriptsWithAlreadyReportedError.size === 1 ? '' : 's';
      process.stderr.write(
        `❌ ${this.#scriptsWithAlreadyReportedError.size.toLocaleString()} script${s} failed.\n`,
      );
    } else {
      process.stderr.write(`❌ Failed.\n`);
    }
  }

  #printSuccessSummary() {
    const elapsed = Math.round((Date.now() - this.#startTime) / 100) / 10;
    // In watch mode, we want to count services that we started as part of this
    // run.
    const count = this.#ran + this.#servicesStarted;
    const s = count === 1 ? '' : 's';
    this.console.log(
      `✅ Ran ${count.toLocaleString()} script${s} and skipped ${this.#skipped.toLocaleString()} in ${elapsed.toLocaleString()}s.`,
    );
  }

  #reportOutputForFailingScript(script: ScriptReference, cause?: Failure) {
    const state = this.#running.get(scriptReferenceToString(script));
    if (!state) {
      throw new Error(
        `Internal error: Got ${
          cause?.reason ? `${cause.reason} event` : 'leftover script'
        } for script without a start event. Events delivered out of order?
    Script with failure: ${scriptReferenceToString(script)}
    Known scripts: ${inspect([...this.#running.keys()])}
`,
      );
    }
    state.replayAndEmptyBuffer();
  }

  #getStatusLine(): StatusLineResult {
    switch (this.#statusLineState) {
      case 'initial': {
        return 'Starting';
      }
      case 'analyzing': {
        return 'Analyzing';
      }
      case 'executing': {
        if (this.#analysisInfo === undefined) {
          return `??? Internal error: Analysis info missing ???`;
        }
        return this.#getExecutionStatusLine(this.#analysisInfo);
      }
      case 'done': {
        // No status line now.
        return nothing;
      }
      default: {
        const never: never = this.#statusLineState;
        throw new Error(`Unknown status line state: ${JSON.stringify(never)}`);
      }
    }
  }

  #getExecutionStatusLine(analysisInfo: AnalysisInfo): StatusLineResult {
    const peekResult = this.#running.peek()?.[1];
    let mostRecentScript = '';
    if (peekResult !== undefined) {
      mostRecentScript =
        ' ' + labelForScript(this.#rootPackage, peekResult.scriptReference);
    }
    const done = this.#finishedScriptsWithCommands.size;
    const total = analysisInfo.scriptsWithCommands.size;
    const percentDone =
      String(Math.round((done / total) * 100)).padStart(3, ' ') + '%';

    let servicesInfo = '';
    if (analysisInfo.hasServices) {
      const s = this.#servicesRunning === 1 ? '' : 's';
      servicesInfo = ` [${this.#servicesRunning.toLocaleString()} service${s}]`;
    }
    let failureInfo = '';
    if (this.#scriptsWithAlreadyReportedError.size > 0) {
      failureInfo = ` [${this.#scriptsWithAlreadyReportedError.size.toLocaleString()} failed]`;
    }
    return `${percentDone} [${done.toLocaleString()} / ${total}] [${
      this.#running.size
    } running]${servicesInfo}${failureInfo}${mostRecentScript}`;
  }

  #markScriptAsFinished(script: ScriptReference) {
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
      this.#analysisInfo === undefined ||
      this.#analysisInfo.scriptsWithCommands.has(key);
    if (isScriptOfInterest) {
      this.#finishedScriptsWithCommands.add(key);
    }
  }

  #handleInfo(event: Info): StatusLineResult {
    if (DEBUG) {
      this.console.log(
        `info: ${event.detail} ${labelForScript(
          this.#rootPackage,
          event.script,
        )}`,
      );
    }
    switch (event.detail) {
      case 'running': {
        const key = scriptReferenceToString(event.script);
        this.#running.set(
          key,
          new ScriptState(
            event.script,
            false,
            this.#analysisInfo?.rootScript === key,
          ),
        );
        return this.#getStatusLine();
      }
      case 'service-process-started': {
        // Services don't end, so we count this as having finished.
        this.#servicesRunning++;
        this.#servicesStarted++;
        const key = scriptReferenceToString(event.script);
        this.#running.set(
          key,
          new ScriptState(
            event.script,
            true,
            this.#analysisInfo?.rootScript === key,
          ),
        );
        this.#markScriptAsFinished(event.script);
        return this.#getStatusLine();
      }
      case 'service-stopped':
        this.#servicesRunning--;
        this.#running.delete(scriptReferenceToString(event.script));
        return this.#getStatusLine();
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
        this.#statusLineState = 'analyzing';
        return this.#getStatusLine();
      }
      case 'analysis-completed': {
        if (!event.rootScriptConfig) {
          // will report the error in printSummary
          this.#statusLineState = 'done';
          return nothing;
        } else {
          this.#statusLineState = 'executing';
          this.#analysisInfo = this.#countScriptsWithCommands(
            event.rootScriptConfig,
          );
          for (const finished of this.#finishedScriptsWithCommands) {
            if (!this.#analysisInfo.scriptsWithCommands.has(finished)) {
              this.#finishedScriptsWithCommands.delete(finished);
            }
          }
        }
        return this.#getStatusLine();
      }
      default: {
        const never: never = event;
        throw new Error(`Unknown info event: ${JSON.stringify(never)}`);
      }
    }
  }

  #handleSuccess(event: Success) {
    if (DEBUG) {
      this.console.log(
        `success: ${event.reason} ${labelForScript(
          this.#rootPackage,
          event.script,
        )}`,
      );
    }
    switch (event.reason) {
      case 'cached': {
        this.#markScriptAsFinished(event.script);
        this.#skipped++;
        return this.#getStatusLine();
      }
      case 'fresh': {
        this.#markScriptAsFinished(event.script);
        this.#skipped++;
        return this.#getStatusLine();
      }
      case 'exit-zero': {
        this.#running.delete(scriptReferenceToString(event.script));
        this.#markScriptAsFinished(event.script);
        this.#ran++;
        return this.#getStatusLine();
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

  #handleFailure(event: Failure): typeof noChange {
    if (DEBUG) {
      this.console.log(
        `failure: ${event.reason} ${labelForScript(
          this.#rootPackage,
          event.script,
        )}`,
      );
    }
    this.#encounteredFailures = true;
    {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      using _pause = this.#statusLineWriter.clearUntilDisposed();
      this.#reportFailure(event);
    }
    return noChange;
  }

  #reportFailure(failure: Failure) {
    const key = scriptReferenceToString(failure.script as ScriptReference);
    if (this.#scriptsWithAlreadyReportedError.has(key)) {
      return;
    }
    this.#scriptsWithAlreadyReportedError.add(key);
    const label = labelForScript(this.#rootPackage, failure.script);
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
        const scriptHadOutput = this.#scriptHadOutput(failure.script);
        const trailer = scriptHadOutput ? ' Output:\n' : '';
        process.stderr.write(`\n❌ [${label}] ${message}.${trailer}\n`);
        if (scriptHadOutput) {
          this.#reportOutputForFailingScript(failure.script, failure);
        }
        this.#finishedScriptsWithCommands.add(key);
        this.#running.delete(key);
        return this.#getStatusLine();
      }
      case 'start-cancelled':
      case 'aborted': {
        // These events aren't very useful to log, because they are downstream
        // of failures that already get reported elsewhere.
        this.#running.delete(scriptReferenceToString(failure.script));
        return this.#getStatusLine();
      }
      case 'dependency-service-exited-unexpectedly': {
        // Also logged elswhere.
        break;
      }
      case 'files-deleted-during-fingerprinting':
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
        this.#defaultLogger.log(failure);
        break;
      default: {
        const never: never = failure;
        throw new Error(`Unknown failure event: ${JSON.stringify(never)}`);
      }
    }
  }

  #scriptHadOutput(script: ScriptReference): boolean {
    const state = this.#running.get(scriptReferenceToString(script));
    if (!state) {
      throw new Error(
        `Internal error: could not find state for failing script. Events delivered out of order?
        Script with output: ${labelForScript(this.#rootPackage, script)}
        ${this.#running.size.toLocaleString()} known running scripts: ${inspect(
          [...this.#running.keys()],
        )}`,
      );
    }
    return state.hasBufferedOutput;
  }

  #handleOutput(event: Output): StatusLineResult {
    const key = scriptReferenceToString(event.script);
    const state = this.#running.get(key);
    if (!state) {
      throw new Error(
        `Internal error: Got output event for unknown script. Events delivered out of order?
        Script with output: ${labelForScript(this.#rootPackage, event.script)}
        ${this.#running.size.toLocaleString()} known running scripts: ${inspect(
          [...this.#running.keys()],
        )}`,
      );
    }
    if (state.service) {
      // Pause the status line while we print this real quick, but then resume
      // it.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      using _pause = this.#statusLineWriter.clearUntilDisposed();
      if (event.stream === 'stdout') {
        process.stdout.write(event.data);
      } else {
        process.stderr.write(event.data);
      }
      return noChange;
    }
    if (state.isRootScript) {
      this.#statusLineState = 'done';
      // Unlike for a service, this is a terminal state, instead of pausing the
      // status line, we stop it completely, because for the rest of the run
      // we're just going to be  printing the root script's output.
      this.#statusLineWriter.clearAndStopRendering();
      if (event.stream === 'stdout') {
        process.stdout.write(event.data);
      } else {
        process.stderr.write(event.data);
      }
      return nothing;
    }
    // Buffer everything else so that we can print it
    // (possibly a second time) in case of failure.
    state.bufferOutput(event);
    return noChange;
  }

  #countScriptsWithCommands(rootScript: ScriptConfig): AnalysisInfo {
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

  [Symbol.dispose]() {
    this.#defaultLogger[Symbol.dispose]();
  }
}
