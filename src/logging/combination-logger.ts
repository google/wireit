/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../event.js';
import {Console, Logger} from './logger.js';

/**
 * A {@link Logger} that logs to multiple loggers.
 */
export class CombinationLogger implements Logger {
  readonly console: Console;
  readonly #loggers: readonly Logger[];

  constructor(loggers: readonly Logger[], console: Console) {
    this.console = console;
    this.#loggers = loggers;
  }

  log(event: Event): void {
    for (const logger of this.#loggers) {
      logger.log(event);
    }
  }
  printMetrics(): void {
    for (const logger of this.#loggers) {
      logger.printMetrics?.();
    }
  }
  getWatchLogger?(): Logger {
    const watchLoggers = this.#loggers.map(
      (logger) => logger.getWatchLogger?.() ?? logger,
    );
    return new CombinationLogger(watchLoggers, this.console);
  }

  [Symbol.dispose](): void {
    for (const logger of this.#loggers) {
      logger[Symbol.dispose]?.();
    }
    this.console[Symbol.dispose]();
  }
}
