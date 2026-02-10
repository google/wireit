/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {WireitTestRig} from './test-rig.js';
import {TestFn} from 'node:test';

/**
 * Returns a promise that resolves after the given period of time.
 */
export const wait = async (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function rigTestNode(
  handler: (args: {rig: WireitTestRig}) => unknown,
  options?: {flaky?: boolean},
): TestFn {
  const runTest = async () => {
    await using rig = await WireitTestRig.setup();
    await handler({rig});
  };
  if (options?.flaky) {
    return async () => {
      try {
        return await runTest();
      } catch {
        console.log('Test failed, retrying...');
      }
      return await runTest();
    };
  } else {
    return runTest;
  }
}
