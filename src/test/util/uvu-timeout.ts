/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as uvu from 'uvu';

export const DEFAULT_UVU_TIMEOUT = Number(process.env.TEST_TIMEOUT ?? 60_000);

/**
 * Returns a promise that resolves after the given period of time.
 */
export const wait = async (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
  ms = DEFAULT_UVU_TIMEOUT,
): uvu.Callback<T> => {
  return (...args) => {
    let timerId: ReturnType<typeof setTimeout>;
    return Promise.race([
      handler(...args),
      new Promise<never>((_resolve, reject) => {
        timerId = setTimeout(() => {
          // Log that we timed out, helpful to see when looking through logs
          // when we started shutting down the rig because of a timeout,
          // because all logs after this point aren't part of the normal test.
          console.error('Test timed out.');
          reject(new Error(`Test timed out after ${ms} milliseconds.`));
        }, ms);
      }),
    ]).finally(() => {
      clearTimeout(timerId);
    });
  };
};
