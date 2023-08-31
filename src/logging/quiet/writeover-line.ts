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

export interface StatusLineWriter {
  clearAndStopRendering(): void;
  updateStatusLine(line: string): void;
  clearUntilDisposed(): Disposable | undefined;
}

abstract class BaseWriteoverLine implements StatusLineWriter {
  private _updateInterval: NodeJS.Timeout | undefined;
  protected _line = '';
  protected _targetFps = 60;
  /**
   * If true, we write over the previous line with a \r carraige return,
   * otherwise we write a new line.
   */
  protected _writeOver = !DEBUG;
  constructor() {
    // If the user does a ctrl-c then we stop the spinner.
    process.on('SIGINT', () => {
      console.log('Got a SIGINT in Writeover line');
      this.clearAndStopRendering();
    });
  }

  /**
   * Called periodically, so that the status line can be updated if needed.
   */
  protected abstract _update(): void;

  clearAndStopRendering() {
    // Writeover the previous line and cancel the spinner interval.
    if (this._updateInterval !== undefined) {
      clearInterval(this._updateInterval);
      this._updateInterval = undefined;
    }
    if (this._line !== '') {
      this._line = '';
      this._writeLine('');
    }
  }

  private _previousLineLength = 0;
  protected _writeLine(line: string) {
    if (!this._writeOver) {
      if (line === '') {
        return;
      }
      process.stderr.write(line);
      process.stderr.write('\n');
      return;
    }
    process.stderr.write(line);
    const overflow = this._previousLineLength - line.length;
    if (overflow > 0) {
      process.stderr.write(' '.repeat(overflow));
    }
    process.stderr.write('\r');
    this._previousLineLength = line.length;
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
    if (this._updateInterval === undefined) {
      return undefined;
    }
    const line = this._line;
    this.clearAndStopRendering();
    return {
      [Symbol.dispose]: () => {
        this.updateStatusLine(line);
      },
    };
  }

  updateStatusLine(line: string) {
    if (DEBUG) {
      if (this._line !== line) {
        // Ensure that every line is written immediately in debug mode
        process.stderr.write(`  ${line}\n`);
      }
    }
    this._line = line;
    if (line === '') {
      // Writeover the previous line and cancel the spinner interval.
      if (this._updateInterval !== undefined) {
        clearInterval(this._updateInterval);
        this._updateInterval = undefined;
      }
      this._writeLine('');
      return;
    }
    if (this._updateInterval !== undefined) {
      // will render on next frame
      return;
    }
    // render now, and then schedule future renders.
    if (!DEBUG) {
      this._update();
    }
    // schedule future renders so the spinner stays going
    this._updateInterval = setInterval(() => {
      if (DEBUG) {
        // We want to schedule an interval even in debug mode, so that tests
        // will still fail if we don't clean it up properly, but we don't want
        // to actually render anything here, since we render any new line
        // the moment it comes in.
        return;
      }
      this._update();
    }, 1000 / this._targetFps);
  }
}

/**
 * Handles displaying a single line of status text, overwriting the previously
 * written line, and displaying a spinner to indicate liveness.
 */
export class WriteoverLine extends BaseWriteoverLine {
  private _spinner = new Spinner();

  private _previouslyWrittenLine: string | undefined = undefined;
  protected override _update() {
    if (this._line === this._previouslyWrittenLine) {
      // just write over the spinner
      process.stderr.write(this._spinner.nextFrame);
      process.stderr.write('\r');
      return;
    }
    this._previouslyWrittenLine = this._line;
    this._writeLine(`${this._spinner.nextFrame} ${this._line}`);
  }
}

/**
 * Like WriteoverLine, but it updates much less frequently, just prints lines
 * rather doing fancy writeover, doesn't draw a spinner, and stays silent
 * if the status line line hasn't changed.
 */
export class CiWriter extends BaseWriteoverLine {
  constructor() {
    super();
    // Don't write too much, no need to flood the CI logs.
    this._targetFps = 1;
    // GitHub seems to handle \r carraige returns the same as \n, but
    // we don't want to rely on that. Just print status lines on new lines.
    this._writeOver = false;
  }

  protected previousLine = '';
  protected override _update() {
    if (this._line === this.previousLine) {
      // nothing new to log
      return;
    }
    this.previousLine = this._line;
    this._writeLine(this._line);
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
