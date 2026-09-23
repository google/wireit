/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// gateWireitFs in wireit-fs-gate.ts loads this into Wireit with "--import",
// and describes the files it uses to talk to the test. Does nothing unless
// WIREIT_TEST_FS_GATE is set.

import * as fs from 'fs';
import * as pathlib from 'path';
import {FsGate} from './fs-gate.js';

const config = process.env['WIREIT_TEST_FS_GATE'];
if (config) {
  const {dir, functions, path, failWith} = JSON.parse(config) as {
    dir: string;
    functions: string[];
    path: string;
    failWith?: string;
  };
  const gate = new FsGate({
    functions,
    path: new RegExp(path),
    failWith,
    onCall: (numCalls) => {
      fs.writeFileSync(pathlib.join(dir, 'calls'), String(numCalls));
    },
  });
  // Only Wireit makes gated calls. The other Node processes that load this,
  // such as npm, don't record their exit code.
  process.on('exit', (code) => {
    if (gate.numCalls > 0) {
      fs.writeFileSync(pathlib.join(dir, 'exit-code'), String(code));
    }
  });
  if (failWith === undefined) {
    void gate.firstCall.then(() => {
      // Registered after Wireit's own handlers, so a "signaled" file means
      // that Wireit has handled the signal.
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => {
          fs.writeFileSync(pathlib.join(dir, 'signaled'), '');
        });
      }
      // Poll, because the test is another process. The interval also keeps
      // this process alive while calls are held.
      const interval = setInterval(() => {
        if (fs.existsSync(pathlib.join(dir, 'release'))) {
          clearInterval(interval);
          gate.release();
        }
      }, 10);
    });
  }
}
