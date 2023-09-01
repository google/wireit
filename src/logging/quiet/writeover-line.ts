/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {DEBUG} from '../logger.js';

// Quick Symbol.dispose polyfill.
if (!Symbol.dispose) {
  type Writeable<T> = { -readonly [P in keyof T]: T[P] };
  (Symbol as Writeable<typeof Symbol>).dispose = Symbol('dispose') as typeof Symbol.dispose;
}

/**
 * Handles displaying a single line of status text, overwriting the previously
 * written line, and displaying a spinner to indicate liveness.
 */
export class WriteoverLine {
  private _previousLineLength = 0;
  private _line = '';
  private _spinnerInterval: NodeJS.Timeout | undefined;
  private _spinner = new Spinner();

  constructor() {
    // If the user does a ctrl-c then we stop the spinner.
    process.on('SIGINT', () => {
      console.log('Got a SIGINT in Writeover line');
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
    if (DEBUG) {
      if (this._line !== line) {
        // Ensure that every line is written immediately in debug mode
        process.stderr.write(`  ${line}\n`);
      }
    }
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
    if (!DEBUG) {
      this._writeLatestLineWithSpinner();
    }
    // a smooth sixty
    let targetFps = 60;
    // Don't flood the CI log system with spinner frames.
    if (process.env.CI) {
      targetFps = 1 / 5;
    }
    // schedule future renders so the spinner stays going
    this._spinnerInterval = setInterval(() => {
      if (DEBUG) {
        // We want to schedule an interval even in debug mode, so that tests
        // will still fail if we don't clean it up properly, but we don't want
        // to actually render anything here, since we render any new line
        // the moment it comes in.
        return;
      }
      this._writeLatestLineWithSpinner();
    }, 1000 / targetFps);
  }

  /**
   * Clears the line and stops the spinner, and returns a Disposable that, once
   * disposed, will restore the line and restart the spinner (if the spinner
   * was going when clearUntilDisposed() was called).
   *
   * Note that we don't expect writeoverLine.writeLine to be called while the
   * Disposable is active, so we don't handle that case. We could, it just
   * hasn't come up yet. We'd need to have an instance variable to count how
   * many active Disposables there are, and only restore the line and restart
   * the spinner when the last one is disposed. We'd also need to short circuit
   * the logic in writeLine, and set aside the latest line to be written.
   *
   * Use like:
   *
   *     {
   *       using _pause = writeoverLine.clearUntilDisposed();
   *       // console.log, write to stdout and stderr, etc
   *     }
   *     // once the block ends, the writeoverLine is restored
   */
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

  private _previouslyWrittenLine: string | undefined = undefined;
  private _writeLatestLineWithSpinner() {
    if (this._line === this._previouslyWrittenLine) {
      // just write over the spinner
      process.stderr.write(this._spinner.nextFrame);
      process.stderr.write('\r');
      return;
    }
    this._previouslyWrittenLine = this._line;
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

const spinnerFrames = [
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
] as const;
class Spinner {
  private _frame = 0;

  get nextFrame() {
    const frame = spinnerFrames[this._frame];
    this._frame = (this._frame + 1) % spinnerFrames.length;
    return frame;
  }
}
