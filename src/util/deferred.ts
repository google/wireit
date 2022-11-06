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
  private _resolve!: (value: T) => void;
  private _reject!: (reason: Error) => void;
  private _settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
  }

  get settled() {
    return this._settled;
  }

  resolve(value: T): void {
    this._settled = true;
    this._resolve(value);
  }

  reject(reason: Error): void {
    this._settled = true;
    this._reject(reason);
  }
}
