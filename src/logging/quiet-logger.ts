/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ScriptConfig, ScriptReference} from '../config.js';
import {Event, Failure, Info, Output, Success} from '../event.js';
import {DefaultLogger, labelForScript} from './default-logger.js';
import {Logger} from './logger.js';

/**
 * A {@link Logger} that prints less to the console.
 *
 * While running, it prints a single line of status text with information about
 * how the run is progressing. When the run is complete, it prints a one line
 * summary of the results if successful, and logs failures with the
 * corresponding script's stderr/stdout if something went wrong.
 */
export class QuietLogger implements Logger {
  private readonly _running = new StackMap<string, ScriptState>();

  private _ran = 0;
  private _cached = 0;
  private _scriptCount = 0;
  private readonly _failures: Array<Failure> = [];
  private readonly _rootPackage: string;
  private readonly _defaultLogger: Logger;
  private readonly _writeoverLine = new WriteoverLine();
  private _state: 'initial' | 'analyzing' | 'running' | 'analysis failed' =
    'initial';
  private readonly _startTime = Date.now();

  constructor(rootPackage: string) {
    this._rootPackage = rootPackage;
    this._defaultLogger = new DefaultLogger(rootPackage);
  }

  printMetrics() {
    this._writeoverLine.clearAndStopSpinner();
    if (this._failures.length > 0 || this._running.size > 0) {
      this._printFailureSummary();
      return;
    }
    this._printSuccessSummary();
  }

  private _printFailureSummary() {
    for (const failure of this._failures) {
      const label = labelForScript(this._rootPackage, failure.script);
      switch (failure.reason) {
        case 'exit-non-zero': {
          process.stderr.write(
            `\n❌ ${label} exited with exit code ${failure.status}. Output:\n\n`
          );
          this._reportOutput(failure.script);
          break;
        }
        case 'signal': {
          process.stderr.write(
            `\n❌ ${label} was killed by signal ${failure.signal}. Output:\n`
          );
          this._reportOutput(failure.script);
          break;
        }
        case 'killed': {
          process.stderr.write(`\n❌ ${label} killed.`);
          this._reportOutput(failure.script);
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
        case 'service-exited-unexpectedly': {
          throw new Error('Quiet logger does not support services.');
        }
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
    for (const [_, state] of this._running) {
      const label = labelForScript(this._rootPackage, state.scriptReference);
      process.stderr.write(`\n❌ ${label} did not exit successfully.`);
      this._reportOutput(state.scriptReference);
    }
    process.stderr.write(`\n❌ Failed.\n`);
  }

  private _printSuccessSummary() {
    const elapsed = Math.round((Date.now() - this._startTime) / 100) / 10;

    console.log(
      `✅ Ran ${this._ran.toLocaleString()} scripts and skipped ${this._cached.toLocaleString()} in ${elapsed.toLocaleString()}s.`
    );
  }

  private _render() {
    switch (this._state) {
      case 'initial': {
        this._writeoverLine.writeLine('Starting');
      }
      case 'analyzing': {
        this._writeoverLine.writeLine('Analyzing');
      }
      case 'running': {
        const peekResult = this._running.peek()?.[1];
        let mostRecentScript = '';
        if (peekResult !== undefined) {
          mostRecentScript = labelForScript(
            this._rootPackage,
            peekResult.scriptReference
          );
        }
        const done = this._ran + this._cached;
        const percentDone =
          String(Math.round((done / this._scriptCount) * 100)).padStart(
            3,
            ' '
          ) + '%';

        this._writeoverLine.writeLine(
          `${percentDone} [${done.toLocaleString()} / ${this._scriptCount.toLocaleString()}] [${
            this._running.size
          } running] ${mostRecentScript}`
        );
        break;
      }
      case 'analysis failed': {
        this._writeoverLine.clearAndStopSpinner();
      }
    }
  }

  private _reportOutput(script: ScriptReference) {
    const state = this._running.get(this._getKey(script));
    if (!state) {
      throw new Error(
        `Internal error: Got exit-non-zero event for unknown script. Events delivered out of order?
    Script with failure: ${this._getKey(script)}
    Known scripts: ${[...this._running.keys()]}
`
      );
    }
    for (const output of state.output) {
      process.stderr.write(output);
    }
    this._running.delete(this._getKey(script));
  }

  private _getKey(script: ScriptReference) {
    return `${script.packageDir}:${script.name}`;
  }

  log(event: Event): void {
    switch (event.type) {
      case 'success': {
        this._handleSuccess(event);
        break;
      }
      case 'failure': {
        this._handleFailure(event);
        break;
      }
      case 'info': {
        this._handleInfo(event);
        return;
      }
      case 'output': {
        this._handleOutput(event);
        break;
      }
      default: {
        const never: never = event;
        throw new Error(`Unknown event type: ${JSON.stringify(never)}`);
      }
    }
  }

  private _handleInfo(event: Info) {
    switch (event.detail) {
      case 'running': {
        this._running.set(
          this._getKey(event.script),
          new ScriptState(event.script)
        );
        this._render();
        return;
      }
      case 'service-started':
      case 'service-stopped':
        throw new Error(`Quiet logger does not support services.`);
      case 'watch-run-end':
      case 'watch-run-start':
        throw new Error(`Quiet logger does not support watch mode.`);
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
        this._render();
        return;
      }
      case 'analysis-completed': {
        if (!event.analyzeResult.config.ok) {
          // will report the error in printSummary
          this._state = 'analysis failed';
          return;
        } else {
          this._state = 'running';
          this._scriptCount = this._countScriptsWithCommands(
            event.analyzeResult.config.value
          );
        }
        this._render();
        return;
      }
      default: {
        const never: never = event;
        throw new Error(`Unknown info event: ${JSON.stringify(never)}`);
      }
    }
  }

  private _handleSuccess(event: Success) {
    switch (event.reason) {
      case 'cached': {
        this._cached++;
        this._render();
        return;
      }
      case 'fresh': {
        this._cached++;
        this._render();
        return;
      }
      case 'exit-zero': {
        this._running.delete(this._getKey(event.script));
        this._ran++;
        this._render();
        return;
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

  private _handleFailure(event: Failure) {
    this._failures.push(event);
  }

  private _handleOutput(event: Output) {
    switch (event.stream) {
      case 'stdout':
      case 'stderr': {
        const state = this._running.get(this._getKey(event.script));
        if (!state) {
          throw new Error(
            `Internal error: Got output event for unknown script. Events delivered out of order?
    Script with output: ${this._getKey(event.script)}
    Known running scripts: ${[...this._running.keys()]} ${this._getKey(
              event.script
            )}`
          );
        }
        state.output.push(event.data);
        return;
      }
      default: {
        const never: never = event;
        throw new Error(`Unknown output event: ${JSON.stringify(never)}`);
      }
    }
  }

  private _countScriptsWithCommands(scriptConfig: ScriptConfig) {
    let count = 0;
    const seen = new Set([this._getKey(scriptConfig)]);
    const toVisit = [scriptConfig];
    while (toVisit.length > 0) {
      const script = toVisit.pop()!;
      if (script.command !== undefined) {
        // We only want to count scripts that actually run, rather than
        // just holding dependencies.
        count++;
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
    return count;
  }
}

class ScriptState {
  readonly output: Array<string | Buffer> = [];
  readonly scriptReference: ScriptReference;
  constructor(scriptReference: ScriptReference) {
    this.scriptReference = scriptReference;
  }
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

  clearAndStopSpinner() {
    // Writeover the previous line and cancel the spinner interval.
    if (this._spinnerInterval !== undefined) {
      clearInterval(this._spinnerInterval);
      this._spinnerInterval = undefined;
    }
    this._writeLineAndScrubPrevious('');
  }

  writeLine(line: string) {
    if (line === '') {
      // Writeover the previous line and cancel the spinner interval.
      if (this._spinnerInterval !== undefined) {
        clearInterval(this._spinnerInterval);
        this._spinnerInterval = undefined;
      }
      this._writeLineAndScrubPrevious('');
      return;
    }
    this._line = line;
    if (this._spinnerInterval !== undefined) {
      // will render on next frame
      return;
    }
    // render now
    this._writeLatestLineWithSpinner();
    // schedule future renders so the spinner stays going
    this._spinnerInterval = setInterval(() => {
      this._writeLatestLineWithSpinner();
    }, 1000 / 60);
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
    process.stderr.write('\r');
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
