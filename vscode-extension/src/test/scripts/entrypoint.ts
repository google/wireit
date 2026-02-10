/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {after} from 'node:test';

/**
 * The vscode test runner expects a function named `run` to be exported,
 * and to return a promise that resolves once the tests are done.
 *
 * This code ensures that we run all of our tests, and wait for them to
 * finish.
 *
 * node:test handles setting the process exit code to a non-zero value
 * if any tests fail.
 */
export async function run(): Promise<void> {
  process.exitCode = 0;
  const finished = new Promise<void>((resolve) => {
    after(() => {
      resolve();
    });
  });
  // Dynamically import the test file so that the after() hook above
  // is registered before any tests start running.
  await import('../main.test.js');
  // Wait for all tests to finish.
  await finished;
  // Wait for a tick of the microtask queue so node:test can finish
  // processing results.
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Our caller doesn't care about the exitCode though, they just care about
  // whether we return or throw.
  if (process.exitCode !== 0) {
    // node:test has already logged the failure to the console so we don't
    // need to. Rejecting with an empty string does the least amount of
    // repeated logging.
    throw '';
  }

  // yay tests pass!
}
