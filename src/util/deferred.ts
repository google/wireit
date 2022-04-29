/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Convenience class for tracking a promise alongside its resolve and reject
 * functions.
 */
export class Deferred<T> {
  readonly promise: Promise<T>;
  #resolve!: (value: T) => void;
  #reject!: (reason: Error) => void;
  #settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  get settled() {
    return this.#settled;
  }

  resolve(value: T): void {
    this.#settled = true;
    this.#resolve(value);
  }

  reject(reason: Error): void {
    this.#settled = true;
    this.#reject(reason);
  }
}
