/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../event.js';
import {Logger, Console} from './logger.js';
import {
  CiWriter,
  StatusLineWriter,
  WriteoverLine,
} from './quiet/writeover-line.js';
import {QuietRunLogger, noChange, nothing} from './quiet/run-tracker.js';

// To prevent using the global console accidentally, we shadow it with
// undefined
const console = undefined;
function markAsUsed(_: unknown) {}
markAsUsed(console);

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
  readonly console: Console;
  #runTracker;
  readonly #rootPackage: string;
  readonly #statusLineWriter: StatusLineWriter;

  constructor(
    rootPackage: string,
    ourConsole: Console,
    statusLineWriter?: StatusLineWriter,
  ) {
    this.#rootPackage = rootPackage;
    this.#statusLineWriter = statusLineWriter ?? new WriteoverLine(ourConsole);
    this.#runTracker = new QuietRunLogger(
      this.#rootPackage,
      this.#statusLineWriter,
      ourConsole,
    );
    this.console = ourConsole;
  }

  printMetrics() {
    this.#statusLineWriter.clearAndStopRendering();
    this.#runTracker.printSummary();
  }

  log(event: Event): void {
    if (event.type === 'info' && event.detail === 'watch-run-start') {
      this.#runTracker = this.#runTracker.makeInstanceForNextWatchRun();
    }
    const line = this.#runTracker.getUpdatedMessageAfterEvent(event);
    if (line === noChange) {
      // nothing to do
    } else if (line === nothing) {
      this.#statusLineWriter.clearAndStopRendering();
    } else {
      this.#statusLineWriter.updateStatusLine(line);
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

  [Symbol.dispose](): void {
    this.#statusLineWriter[Symbol.dispose]();
    this.#runTracker[Symbol.dispose]();
    this.console[Symbol.dispose]();
  }
}

/**
 * A QuietLogger that is intended to be used in CI environments and other
 * non-interactive environments.
 *
 * Doesn't use a spinner, updates less often, and doesn't use '/r' to writeover
 * the previous line.
 */
export class QuietCiLogger extends QuietLogger {
  constructor(rootPackage: string, ourConsole: Console) {
    super(rootPackage, ourConsole, new CiWriter(ourConsole));
  }
}
