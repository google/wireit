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
 * - Wireit writes its exit code into "exit-code" as it exits.
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

    /**
     * The exit code of the last Wireit process that made a gated call. A test
     * that sends a signal should check this rather than the exit code of the
     * command the rig ran. The rig runs Wireit through a shell and npm, which
     * get the signal too, and some shells, such as dash on Ubuntu, die from it
     * instead of passing on Wireit's exit code.
     */
    exitCode: async () =>
      Number(await rig.read(pathlib.join(dir, 'exit-code'))),

    /** Waits until Wireit has handled a SIGINT or SIGTERM. */
    signaled: (exec: ExecResult) =>
      pollUntil('handling the signal', () => fileExists('signaled'), exec),

    release,
    [Symbol.asyncDispose]: release,
  };
}
