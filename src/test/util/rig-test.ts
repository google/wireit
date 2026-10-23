/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {WireitTestRig} from './test-rig.js';
import {TestFn} from 'node:test';

import type {ExecResult} from './test-rig.js';

export const DEFAULT_TIMEOUT = Number(process.env.TEST_TIMEOUT ?? 60_000);

/**
 * Returns a promise that resolves after the given period of time.
 */
export const wait = async (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls until `condition` is true. Throws if `exec` has exited, or after
 * {@link DEFAULT_TIMEOUT}.
 *
 * This and {@link withTimeout} give up on their own because node:test's
 * timeout fails a test without stopping it. A test that waited forever would
 * never reach its cleanup, which could leave a Wireit process running.
 */
export async function pollUntil(
  what: string,
  condition: () => Promise<boolean>,
  exec: ExecResult,
): Promise<void> {
  const deadline = Date.now() + DEFAULT_TIMEOUT;
  while (!(await condition())) {
    if (!exec.running) {
      throw new Error(`Wireit exited before ${what}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await wait(5);
  }
}

/** Settles as `promise` does, but rejects after {@link DEFAULT_TIMEOUT}. */
export async function withTimeout<T>(
  what: string,
  promise: Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${what}`)),
          DEFAULT_TIMEOUT,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Like exec.waitForLog, but throws after {@link DEFAULT_TIMEOUT}. */
export const waitForLog = (exec: ExecResult, matcher: RegExp) =>
  withTimeout(`a log matching ${String(matcher)}`, exec.waitForLog(matcher));

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
