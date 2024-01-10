/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Deferred} from './deferred.js';

/**
 * A mechanism for ensuring that at most N tasks are taking place at once.
 *
 * Useful in Wireit to prevent running too many scripts at once and swamping
 * the system. For unlimited parallelism, just set numWorkers to Infinity.
 *
 * Note that node is still single threaded by default. This is useful for
 * Wireit because almost all work is happening in script commands which run
 * in separate processes.
 *
 * No guarantee is made about ordering or fairness of scheduling, though
 * as implemented it's currently LIFO. Deadlocks may occur if there are
 * dependencies between tasks.
 */
export class WorkerPool {
  #availableWorkers: number;
  readonly #waitingWorkers: Deferred<void>[] = [];

  constructor(numWorkers: number) {
    if (numWorkers <= 0) {
      throw new Error(
        `WorkerPool needs a positive number of workers, got ${numWorkers}`,
      );
    }
    this.#availableWorkers = numWorkers;
  }

  /**
   * Calls workFn and returns its result.
   *
   * However, no more than `numWorkers` simultaneous calls to workFns will
   * be running at any given time, to prevent overloading the machine.
   */
  async run<T>(workFn: () => Promise<T>): Promise<T> {
    if (this.#availableWorkers <= 0) {
      const waiter = new Deferred<void>();
      this.#waitingWorkers.push(waiter);
      await waiter.promise;
      if (this.#availableWorkers <= 0) {
        throw new Error(
          `Internal error: expected availableWorkers to be positive after task was awoken, but was ${this.#availableWorkers}`,
        );
      }
    }
    this.#availableWorkers--;
    try {
      return await workFn();
    } finally {
      this.#availableWorkers++;
      if (this.#availableWorkers <= 0) {
        // We intend to override any return or throw with this error in this
        // case.
        // eslint-disable-next-line no-unsafe-finally
        throw new Error(
          `Internal error: expected availableWorkers to be positive after incrementing, but was ${this.#availableWorkers}`,
        );
      }
      this.#waitingWorkers.pop()?.resolve();
    }
  }
}
