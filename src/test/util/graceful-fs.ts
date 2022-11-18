/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Try running the given async function, but if it fails with a possibly
 * transient filesystem error (like `EBUSY`), then retry a few times with
 * exponential(ish) backoff.
 */
export async function gracefulFs<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error: unknown) {
    if (!isRetryableFsError(error)) {
      throw error;
    }
  }
  let finalError: unknown;
  for (const sleep of [10, 100, 500, 1000]) {
    await new Promise((resolve) => setTimeout(resolve, sleep));
    try {
      return await fn();
    } catch (error: unknown) {
      if (!isRetryableFsError(error)) {
        throw error;
      }
      finalError = error;
    }
  }
  throw finalError;
}

function isRetryableFsError(error: unknown): boolean {
  const code = (error as {code?: string}).code;
  return code === 'EBUSY';
}
