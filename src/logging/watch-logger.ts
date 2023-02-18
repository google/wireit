/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Event} from '../event.js';
import type {Logger} from './logger.js';
import {MetricsLogger} from './metrics-logger.js';

/**
 * A logger for watch mode that avoids useless output.
 */
export class WatchLogger implements Logger {
  private readonly _actualLogger: MetricsLogger;
  private readonly _iterationBuffer: Event[] = [];
  private _iterationIsInteresting =
    /* The first iteration is always interesting. */ true;

  constructor(actualLogger: MetricsLogger) {
    this._actualLogger = actualLogger;
  }

  log(event: Event) {
    if (this._iterationIsInteresting) {
      // This iteration previously had an interesting event (or it's the very
      // first one, which we always show).
      this._actualLogger.log(event);
      this._actualLogger.printMetrics();

      if (this._isWatchRunEnd(event)) {
        // only want to print metrics at the end of a watch iteration that
        // actually was interesting
        this._iterationIsInteresting = false;
      }
    } else if (this._isWatchRunEnd(event)) {
      // We finished a watch iteration and nothing interesting ever happened.
      // Discard the buffer.
      this._iterationBuffer.length = 0;
    } else if (this._isInteresting(event)) {
      // The first interesting event of the iteration. Flush the buffer and log
      // everything from now until the next iteration.
      while (this._iterationBuffer.length > 0) {
        this._actualLogger.log(this._iterationBuffer.shift()!);
      }
      this._actualLogger.log(event);
      this._iterationIsInteresting = true;
    } else {
      // An uninteresting event in a thus far uninteresting iteration.
      this._iterationBuffer.push(event);
    }
  }

  private _isInteresting(event: Event): boolean {
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
      case 'locked': {
        return false;
      }
    }
    return true;
  }

  private _isWatchRunEnd(event: Event): boolean {
    return event.type === 'info' && event.detail === 'watch-run-end';
  }
}
