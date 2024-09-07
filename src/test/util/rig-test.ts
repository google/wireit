/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as uvu from 'uvu';
import {WireitTestRig} from './test-rig.js';

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
const timeout = <T>(
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

export const rigTest = <T extends {rig?: WireitTestRig}>(
  handler: uvu.Callback<T & {rig: WireitTestRig}>,
  inputOptions?: {flaky?: boolean; ms?: number},
): uvu.Callback<T> => {
  const {flaky, ms} = {
    flaky: false,
    ms: DEFAULT_UVU_TIMEOUT,
    ...inputOptions,
  };
  const runTest: uvu.Callback<T> = async (context) => {
    await using rig = await (async () => {
      if (context.rig !== undefined) {
        // if the suite provides a rig, use it, it's already been
        // configured for these tests specifically.
        // we'll dispose of it ourselves, but that's ok, disposing multiple
        // times is a noop
        return context.rig;
      }
      const rig = new WireitTestRig();

      await rig.setup();
      return rig;
    })();
    try {
      await timeout(handler, ms)({...context, rig});
    } catch (e) {
      const consoleCommandRed = '\x1b[31m';
      const consoleReset = '\x1b[0m';
      const consoleBold = '\x1b[1m';
      console.log(
        `${consoleCommandRed}✘${consoleReset} Test failed: ${consoleBold}${context.__test__}${consoleReset}`,
      );
      console.group();
      await rig.reportFullLogs();
      console.groupEnd();
      throw e;
    }
  };

  if (flaky) {
    return async (context) => {
      try {
        return await runTest(context);
      } catch {
        console.log('Test failed, retrying...');
      }
      return await runTest(context);
    };
  }
  return runTest;
};
