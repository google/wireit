/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as uvu from 'uvu';
import {Deferred} from '../../util/deferred.js';

const DEFAULT_TIMEOUT = Number(process.env.TEST_TIMEOUT ?? 30_000);

/**
 * Returns a promise that resolves after the given period of time.
 *
 * If aborted before resolution, the promise never resolves.
 */
export const wait = async (ms: number, abort?: AbortSignal) => {
  const deferred = new Deferred<void>();
  const timerId = setTimeout(() => {
    deferred.resolve();
  }, ms);
  function onAbort() {
    clearTimeout(timerId);
  }
  if (abort?.aborted) {
    onAbort();
  }
  abort?.addEventListener('abort', () => onAbort(), {once: true});
  return deferred.promise;
};

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
    const abort = new AbortController();
    return Promise.race([
      handler(...args),
      wait(ms, abort.signal).then(() => {
        throw new Error(`Test timed out after ${ms} milliseconds.`);
      }),
    ]).finally(() => {
      abort.abort();
    });
  };
};
