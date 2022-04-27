/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'path';

import {runTests} from '@vscode/test-electron';

/**
 * Downloads vscode and starts it in extension test mode, pointing it at
 * ./uvu-entrypoint
 *
 * Note that uvu-entrypoint runs in its own process, inside of electron.
 */
async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
  const extensionTestsPath = path.resolve(__dirname, './uvu-entrypoint.js');
  await runTests({extensionDevelopmentPath, extensionTestsPath});
}

main().catch((err: unknown) => {
  if (err === 'Failed') {
    // The tests failed in a normal way, so the error has already been logged
    // by uvu. All we need to do here is just to exit with a nonzero code.
  } else {
    console.error('Failed to run tests:');
    console.error(err);
  }
  process.exit(1);
});
