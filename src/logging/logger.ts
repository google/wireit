/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Event} from '../event.js';
import '../util/dispose.js';
import {Console as NodeConsole} from 'node:console';

export class Console extends NodeConsole {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly #closeStreams;
  #closed = false;
  constructor(
    stdout: NodeJS.WritableStream,
    stderr: NodeJS.WritableStream,
    closeStreams = false,
  ) {
    super(stdout, stderr);
    this.stdout = stdout;
    this.stderr = stderr;
    this.#closeStreams = closeStreams;
  }

  [Symbol.dispose](): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#closeStreams) {
      this.stdout.end();
      this.stderr.end();
    }
  }
}

/**
 * Logs Wireit events in some way.
 */
export interface Logger extends Disposable {
  readonly console: Console;

  log(event: Event): void;
  printMetrics(): void;

  // Some loggers need additional logic when run in watch mode.
  // If this method is present, we'll call it and use the result when in
  // watch mode.
  getWatchLogger?(): Logger;
}

/**
 * When true, we're debugging the logger itself, so a logger should log with
 * more verbosity, and not overwrite previously written lines.
 */
export const DEBUG = Boolean(process.env['WIREIT_DEBUG_LOGGER']);
