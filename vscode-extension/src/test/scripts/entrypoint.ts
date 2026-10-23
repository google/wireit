/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {tests} from '../main.test.js';

/**
 * The vscode test runner expects a function named `run` to be exported,
 * and to return a promise that resolves once the tests are done.
 *
 * Runs each exported test sequentially and reports results.
 */
export async function run(): Promise<void> {
  process.exitCode = 0;
  const failures: string[] = [];

  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failures.push(name);
      console.error(`  ✗ ${name}`);
      console.error(error);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `${failures.length} test(s) failed: ${failures.join(', ')}`,
    );
  }
}
