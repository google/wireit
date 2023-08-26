/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {DEBUG} from '../logger.js';

// Quick Symbol.dispose polyfill.
{
  type Mutable<T> = {-readonly [P in keyof T]: T[P]};
  (Symbol as Mutable<typeof Symbol>).dispose =
    Symbol.dispose ?? Symbol('dispose');
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

  consturctor() {
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
