/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {TestFn} from 'node:test';

/**
 * Returns a promise that resolves after the given period of time.
 */
export const wait = async (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wraps a test function so that if it fails, it is retried once. Useful for
 * tests that are inherently flaky (e.g. file watchers with timing-sensitive
 * behavior).
 *
 * Usage:
 *   test('some flaky test', flakyTest(async () => {
 *     await using rig = await WireitTestRig.setup();
 *     // ...
 *   }));
 */
export function flakyTest(fn: () => Promise<void>): TestFn {
  return async () => {
    try {
      return await fn();
    } catch {
      console.log('Test failed, retrying...');
    }
    return await fn();
  };
}
