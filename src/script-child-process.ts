/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import {spawn} from 'child_process';
import {augmentProcessEnvSafelyIfOnWindows} from './util/windows.js';

import type {Result} from './error.js';
import type {ScriptConfigWithRequiredCommand} from './script.js';
import type {ChildProcessWithoutNullStreams} from 'child_process';
import type {ExitNonZero, ExitSignal, SpawnError} from './event.js';

/**
 * The PATH environment variable of this process, minus all of the leading
 * "node_modules/.bin" entries that the incoming "npm run" command already set.
 *
 * We want full control over which "node_modules/.bin" paths are in the PATH of
 * the processes we spawn, so that cross-package dependencies act as though we
 * are running "npm run" with each package as the cwd.
 *
 * We only need to do this once per Wireit process, because process.env never
 * changes.
 */
const PATH_ENV_SUFFIX = (() => {
  const path = process.env.PATH ?? '';
  // Note the PATH delimiter is platform-dependent.
  const entries = path.split(pathlib.delimiter);
  const nodeModulesBinSuffix = pathlib.join('node_modules', '.bin');
  const endOfNodeModuleBins = entries.findIndex(
    (entry) => !entry.endsWith(nodeModulesBinSuffix)
  );
  return entries.slice(endOfNodeModuleBins).join(pathlib.delimiter);
})();

/**
 * A child process spawned during execution of a script.
 */
export class ScriptChildProcess {
  readonly #script: ScriptConfigWithRequiredCommand;
  readonly #child: ChildProcessWithoutNullStreams;

  /**
   * Resolves when this child process ends.
   */
  readonly completed: Promise<
    Result<void, SpawnError | ExitSignal | ExitNonZero>
  >;

  get stdout() {
    return this.#child.stdout;
  }

  get stderr() {
    return this.#child.stderr;
  }

  constructor(script: ScriptConfigWithRequiredCommand) {
    this.#script = script;

    // TODO(aomarks) Update npm_ environment variables to reflect the new
    // package.
    this.#child = spawn(script.command.value, {
      cwd: script.packageDir,
      // Conveniently, "shell:true" has the same shell-selection behavior as
      // "npm run", where on macOS and Linux it is "sh", and on Windows it is
      // %COMSPEC% || "cmd.exe".
      //
      // References:
      //   https://nodejs.org/api/child_process.html#child_processspawncommand-args-options
      //   https://nodejs.org/api/child_process.html#default-windows-shell
      //   https://github.com/npm/run-script/blob/a5b03bdfc3a499bf7587d7414d5ea712888bfe93/lib/make-spawn-args.js#L11
      shell: true,
      env: augmentProcessEnvSafelyIfOnWindows({
        PATH: this.#pathEnvironmentVariable,
      }),
    });

    this.completed = new Promise((resolve) => {
      this.#child.on('error', (error) => {
        resolve({
          ok: false,
          error: {
            script,
            type: 'failure',
            reason: 'spawn-error',
            message: error.message,
          },
        });
      });

      this.#child.on('close', (status, signal) => {
        if (signal !== null) {
          resolve({
            ok: false,
            error: {
              script,
              type: 'failure',
              reason: 'signal',
              signal,
            },
          });
        } else if (status !== 0) {
          resolve({
            ok: false,
            error: {
              script,
              type: 'failure',
              reason: 'exit-non-zero',
              // status should only ever be null if signal was not null, but
              // this isn't reflected in the TypeScript types. Just in case, and
              // to make TypeScript happy, fall back to -1 (which is a
              // conventional exit status used for "exited with signal").
              status: status ?? -1,
            },
          });
        } else {
          resolve({ok: true, value: undefined});
        }
      });
    });
  }

  /**
   * Generates the PATH environment variable that should be set when this
   * script's command is spawned.
   */
  get #pathEnvironmentVariable(): string {
    // Given package "/foo/bar", walk up the path hierarchy to generate
    // "/foo/bar/node_modules/.bin:/foo/node_modules/.bin:/node_modules/.bin".
    const entries = [];
    let cur = this.#script.packageDir;
    while (true) {
      entries.push(pathlib.join(cur, 'node_modules', '.bin'));
      const parent = pathlib.dirname(cur);
      if (parent === cur) {
        break;
      }
      cur = parent;
    }
    // Add the inherited PATH variable, minus any "node_modules/.bin" entries
    // that were set by the "npm run" command that spawned Wireit.
    entries.push(PATH_ENV_SUFFIX);
    // Note the PATH delimiter is platform-dependent.
    return entries.join(pathlib.delimiter);
  }
}
