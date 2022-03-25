/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as uvu from 'uvu';

const DEFAULT_TIMEOUT = Number(process.env.TEST_TIMEOUT ?? 30_000);

/**
 * Wraps an uvu test function so that it fails if the function doesn't complete
 * in the given amount of time. Uvu has no built-in timeout support (see
 * https://github.com/lukeed/uvu/issues/33).
 *
 * @param handler The uvu test function.
 * @param ms Millisecond failure timeout.
 */
export const timeout = <T>(
  handler: uvu.Callback<T>,
  ms = DEFAULT_TIMEOUT
): uvu.Callback<T> => {
  return (...args) => {
    let timerId: ReturnType<typeof setTimeout>;
    return Promise.race([
      handler(...args),
      new Promise<never>((_resolve, reject) => {
        timerId = setTimeout(
          () => reject(new Error(`Test timed out after ${ms} milliseconds.`)),
          ms
        );
      }),
    ]).finally(() => {
      clearTimeout(timerId);
    });
  };
};
