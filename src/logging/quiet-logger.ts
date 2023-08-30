/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../event.js';
import {Logger} from './logger.js';
import {WriteoverLine} from './quiet/writeover-line.js';
import {QuietRunLogger, noChange, nothing} from './quiet/run-tracker.js';

/**
 * A {@link Logger} that prints less to the console.
 *
 * While running, it prints a single line of status text with information about
 * how the run is progressing, as well as emitting errors as they happen,
 * and any output from services or the root script.
 *
 * When the run is complete, it prints a one line summary of the results.
 */
export class QuietLogger implements Logger {
  private runTracker;
  private readonly _rootPackage: string;
  private readonly _writeoverLine = new WriteoverLine();

  constructor(rootPackage: string) {
    this._rootPackage = rootPackage;
    this.runTracker = new QuietRunLogger(
      this._rootPackage,
      this._writeoverLine,
    );
  }

  printMetrics() {
    this._writeoverLine.clearAndStopSpinner();
    this.runTracker.printSummary();
  }

  log(event: Event): void {
    if (event.type === 'info' && event.detail === 'watch-run-start') {
      this.runTracker = this.runTracker.makeInstanceForNextWatchRun();
    }
    const line = this.runTracker.getUpdatedMessageAfterEvent(event);
    if (line === noChange) {
      // nothing to do
    } else if (line === nothing) {
      this._writeoverLine.clearAndStopSpinner();
    } else {
      this._writeoverLine.writeLine(line);
    }
    if (event.type === 'info' && event.detail === 'watch-run-end') {
      this.printMetrics();
    }
  }

  getWatchLogger(): Logger {
    // QuietLogger doesn't need the screen-clearning behavior of the watch
    // logger, since in successful cases it only prints one line of output,
    // and in failure cases it can be nice to keep the old output around.
    return this;
  }
}
