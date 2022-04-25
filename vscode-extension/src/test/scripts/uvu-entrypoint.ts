/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {test} from '../main.test.js';

/**
 * The vscode test runner expects a function named `run` to be exported,
 * and to return a promise that resolves once the tests are done.
 *
 * This code ensures that we run all of our tests, and wait for them to
 * finish.
 *
 * uvu itself handles setting the process exit code to a non-zero value
 * if any tests fail.
 */
export async function run(): Promise<void> {
  process.exitCode = 0;
  const finished = new Promise<void>((resolve) => {
    test.after((result) => {
      console.log(`after result:`, result);
      resolve();
    });
  });
  test.run();
  // wait for the test to finish
  await finished;
  // wait for a tick of the microtask queue so uvu can finish processing results
  await new Promise((resolve) => setTimeout(resolve, 0));
  // our caller doesn't care about the exitCode though, they just care about
  // whether we return or throw
  if (process.exitCode !== 0) {
    // uvu has already logged the failure to the console so we don't need to
    // rejecting with an empty string does the least amount of repeated logging
    throw '';
  }

  // yay tests pass!
}
