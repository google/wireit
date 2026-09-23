/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import {pollUntil} from './rig-test.js';

import type {FsGateOptions} from './fs-gate.js';
import type {ExecResult, WireitTestRig} from './test-rig.js';

/**
 * Makes the Wireit processes that the rig starts from now on gate file system
 * calls as {@link FsGate} does. Disposing releases the held calls, so that a
 * failed test doesn't leave Wireit waiting.
 *
 * Node's "--import" flag, passed in NODE_OPTIONS, loads fs-gate-preload.ts
 * into every Node process the rig starts, before that process's own code. The
 * preload does nothing unless WIREIT_TEST_FS_GATE is set, which this function
 * sets. Wireit and the test are separate processes, so they talk through files
 * in a folder that this function creates in the rig:
 *
 * - Wireit writes the number of gated calls so far into "calls".
 * - Wireit creates "signaled" once it has handled a SIGINT or SIGTERM.
 * - The test creates "release" to let the held calls run.
 */
export async function gateWireitFs(
  rig: WireitTestRig,
  options: Omit<FsGateOptions, 'onCall'>,
) {
  const dir = 'fs-gate';
  await rig.mkdir(dir);
  const preload = new URL('./fs-gate-preload.js', import.meta.url);
  rig.env = {
    ...rig.env,
    WIREIT_TEST_FS_GATE: JSON.stringify({
      dir: rig.resolve(dir),
      functions: options.functions,
      path: options.path.source,
      failWith: options.failWith,
    }),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload.href}`]
      .filter(Boolean)
      .join(' '),
  };
  const fileExists = (name: string) => rig.exists(pathlib.join(dir, name));
  const release = () => rig.write(pathlib.join(dir, 'release'), '');
  return {
    /** Waits for Wireit's first gated call. */
    firstCall: (exec: ExecResult) =>
      pollUntil('a gated call', () => fileExists('calls'), exec),

    /** The number of gated calls so far. */
    numCalls: async () =>
      (await fileExists('calls'))
        ? Number(await rig.read(pathlib.join(dir, 'calls')))
        : 0,

    /** Waits until Wireit has handled a SIGINT or SIGTERM. */
    signaled: (exec: ExecResult) =>
      pollUntil('handling the signal', () => fileExists('signaled'), exec),

    release,
    [Symbol.asyncDispose]: release,
  };
}
