/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {WireitTestRig} from './test-rig.js';
import {TestFn} from 'node:test';

export const DEFAULT_TIMEOUT = Number(process.env.TEST_TIMEOUT ?? 60_000);

/**
 * Returns a promise that resolves after the given period of time.
 */
export const wait = async (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function rigTest(
  handler: (args: {rig: WireitTestRig}) => unknown,
  options?: {
    flaky?: boolean;
    ms?: number;
    env?: Record<string, string | undefined>;
  },
): TestFn {
  const ms = options?.ms;
  const runTest = async () => {
    await using rig = await WireitTestRig.setup();
    if (options?.env) {
      rig.env = {...rig.env, ...options.env};
    }
    const work = handler({rig});
    if (ms !== undefined) {
      let timerId: ReturnType<typeof setTimeout>;
      await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timerId = setTimeout(() => {
            console.error('Test timed out.');
            reject(new Error(`Test timed out after ${ms} milliseconds.`));
          }, ms);
        }),
      ]).finally(() => {
        clearTimeout(timerId);
      });
    } else {
      await work;
    }
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
