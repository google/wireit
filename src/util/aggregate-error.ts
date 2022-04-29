/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ponyfill for ES2022 AggregateError.
 *
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/AggregateError
 * https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-aggregate-error-objects
 */
export class AggregateError {
  errors: unknown[];
  message?: string;

  constructor(errors: Iterable<unknown>, message = '') {
    this.errors = [...errors];
    this.message = message;
  }
}
