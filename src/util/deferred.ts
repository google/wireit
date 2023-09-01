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
  readonly #resolve: (value: T) => void;
  readonly #reject: (reason: Error) => void;
  #settled = false;

  constructor() {
    let res: (value: T) => void, rej: (reason: Error) => void;
    this.promise = new Promise<T>((resolve, reject) => {
      res = resolve;
      rej = reject;
    });
    this.#resolve = res!;
    this.#reject = rej!;
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
