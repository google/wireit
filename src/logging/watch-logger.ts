/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Event} from '../event.js';
import type {Logger} from './logger.js';

/**
 * A logger for watch mode that avoids useless output.
 */
export class WatchLogger implements Logger {
  readonly #actualLogger: Logger;
  readonly #iterationBuffer: Event[] = [];
  #iterationIsInteresting =
    /* The first iteration is always interesting. */ true;

  constructor(actualLogger: Logger) {
    this.#actualLogger = actualLogger;
  }

  log(event: Event) {
    if (this.#iterationIsInteresting) {
      // This iteration previously had an interesting event (or it's the very
      // first one, which we always show).
      this.#actualLogger.log(event);
      this.#actualLogger.printMetrics();

      if (this.#isWatchRunEnd(event)) {
        this.#iterationIsInteresting = false;
      }
    } else if (this.#isWatchRunEnd(event)) {
      // We finished a watch iteration and nothing interesting ever happened.
      // Discard the buffer.
      this.#iterationBuffer.length = 0;
    } else if (this.#isInteresting(event)) {
      // The first interesting event of the iteration. Flush the buffer and log
      // everything from now until the next iteration.
      while (this.#iterationBuffer.length > 0) {
        this.#actualLogger.log(this.#iterationBuffer.shift()!);
      }
      this.#actualLogger.log(event);
      this.#iterationIsInteresting = true;
    } else {
      // An uninteresting event in a thus far uninteresting iteration.
      this.#iterationBuffer.push(event);
    }
  }

  printMetrics(): void {
    // printMetrics() not used in watch-logger.
  }

  #isInteresting(event: Event): boolean {
    const code =
      event.type === 'output'
        ? event.stream
        : event.type === 'info'
        ? event.detail
        : event.reason;
    switch (code) {
      case 'fresh':
      case 'no-command':
      case 'failed-previous-watch-iteration':
      case 'watch-run-start':
      case 'start-cancelled':
      case 'locked':
      case 'analysis-completed': {
        return false;
      }
    }
    return true;
  }

  #isWatchRunEnd(event: Event): boolean {
    return event.type === 'info' && event.detail === 'watch-run-end';
  }

  [Symbol.dispose](): void {
    this.#actualLogger[Symbol.dispose]();
  }
}
