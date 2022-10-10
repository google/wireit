/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import {spawn} from 'child_process';
import {
  augmentProcessEnvSafelyIfOnWindows,
  IS_WINDOWS,
} from './util/windows.js';
import {Deferred} from './util/deferred.js';

import type {Result} from './error.js';
import type {ScriptConfig} from './config.js';
import type {ChildProcessWithoutNullStreams} from 'child_process';
import type {ExitNonZero, ExitSignal, SpawnError, Killed} from './event.js';

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

export type ScriptChildProcessState =
  | 'starting'
  | 'started'
  | 'killing'
  | 'stopped';

/**
 * A script config but the command is required.
 */
type ScriptConfigWithRequiredCommand = ScriptConfig & {
  command: Exclude<ScriptConfig['command'], undefined>;
};

/**
 * A child process spawned during execution of a script.
 */
export class ScriptChildProcess {
  private readonly _script: ScriptConfigWithRequiredCommand;
  private readonly _child: ChildProcessWithoutNullStreams;
  private readonly _started = new Deferred<Result<void, SpawnError>>();
  private readonly _completed = new Deferred<
    Result<void, SpawnError | ExitSignal | ExitNonZero | Killed>
  >();
  private _state: ScriptChildProcessState = 'starting';

  /**
   * Resolves when this process starts
   */
  get started(): Promise<Result<void, SpawnError>> {
    return this._started.promise;
  }

  /**
   * Resolves when this child process ends.
   */
  get completed(): Promise<
    Result<void, SpawnError | ExitSignal | ExitNonZero | Killed>
  > {
    return this._completed.promise;
  }

  get stdout() {
    return this._child.stdout;
  }

  get stderr() {
    return this._child.stderr;
  }

  constructor(script: ScriptConfigWithRequiredCommand) {
    this._script = script;

    // TODO(aomarks) Update npm_ environment variables to reflect the new
    // package.
    this._child = spawn(script.command.value, script.extraArgs, {
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
        FORCE_COLOR:
          process.stdout.isTTY && process.env.FORCE_COLOR === undefined
            ? 'true'
            : process.env.FORCE_COLOR,
        PATH: this._pathEnvironmentVariable,
      }),
      // Set "detached" on Linux and macOS so that we create a new process
      // group, instead of being added to the process group for this Wireit
      // process.
      //
      // We need a new process group so that we can use "kill(-pid)" to kill all
      // of the processes in the process group, instead of just the group leader
      // "sh" process. "sh" does not forward signals to child processes, so a
      // regular "kill(pid)" would not kill the actual process we care about.
      //
      // On Windows this works differently, and we use the "\t" flag to
      // "taskkill" to kill child processes. However, if we do set "detached" on
      // Windows, it causes the child process to open in a new terminal window,
      // which we don't want.
      detached: !IS_WINDOWS,
    });

    this._child.on('spawn', () => {
      switch (this._state) {
        case 'starting': {
          this._started.resolve({ok: true, value: undefined});
          this._state = 'started';
          break;
        }
        case 'killing': {
          this._started.resolve({ok: true, value: undefined});
          // We received a kill request while we were still starting. Kill now
          // that we're started.
          this._actuallyKill();
          break;
        }
        case 'started':
        case 'stopped': {
          const exception = new Error(
            `Internal error: Expected ScriptChildProcessState ` +
              `to be "started" or "killing" but was "${this._state}"`
          );
          this._started.reject(exception);
          this._completed.reject(exception);
          break;
        }
        default: {
          const never: never = this._state;
          const exception = new Error(
            `Internal error: unexpected ScriptChildProcessState: ${String(
              never
            )}`
          );
          this._started.reject(exception);
          this._completed.reject(exception);
        }
      }
    });

    this._child.on('error', (error) => {
      const result = {
        ok: false,
        error: {
          script,
          type: 'failure',
          reason: 'spawn-error',
          message: error.message,
        },
      } as const;
      this._started.resolve(result);
      this._completed.resolve(result);
      this._state = 'stopped';
    });

    this._child.on('close', (status, signal) => {
      if (this._state === 'killing') {
        this._completed.resolve({
          ok: false,
          error: {
            script,
            type: 'failure',
            reason: 'killed',
          },
        });
      } else if (signal !== null) {
        this._completed.resolve({
          ok: false,
          error: {
            script,
            type: 'failure',
            reason: 'signal',
            signal,
          },
        });
      } else if (status !== 0) {
        this._completed.resolve({
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
        this._completed.resolve({ok: true, value: undefined});
      }
      this._state = 'stopped';
    });
  }

  /**
   * Kill this child process. On Linux/macOS, sends a `SIGINT` signal. On
   * Windows, invokes `taskkill /pid PID /t`.
   *
   * Note this function returns immediately. To find out when the process was
   * actually killed, use the {@link completed} promise.
   */
  kill(): void {
    switch (this._state) {
      case 'started': {
        this._actuallyKill();
        return;
      }
      case 'starting': {
        // We're still starting up, and it's not possible to abort. When we get
        // the "spawn" event, we'll notice the "killing" state and actually kill
        // then.
        this._state = 'killing';
        return;
      }
      case 'killing':
      case 'stopped': {
        // No-op.
        return;
      }
      default: {
        const never: never = this._state;
        throw new Error(
          `Internal error: unexpected ScriptChildProcessState: ${String(never)}`
        );
      }
    }
  }

  private _actuallyKill(): void {
    if (this._child.pid === undefined) {
      throw new Error(
        `Internal error: Can't kill child process because it has no pid. ` +
          `Command: ${JSON.stringify(this._script.command)}.`
      );
    }
    if (IS_WINDOWS) {
      // Windows doesn't have signals. Node ChildProcess.kill() sort of emulates
      // the behavior of SIGKILL (and ignores the signal you pass in), but this
      // doesn't end child processes. We have child processes because the parent
      // process is the shell (cmd.exe or PowerShell).
      // https://docs.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill
      spawn('taskkill', [
        '/pid',
        this._child.pid.toString(),
        /* End child processes */ '/t',
        /* Force. Killing does not seem reliable otherwise. */ '/f',
      ]);
    } else {
      // We used "detached" when we spawned, so our child is the leader of a
      // process group. Passing the negative of a pid kills all processes in
      // that group (without the negative, only the leader "sh" process would be
      // killed).
      process.kill(-this._child.pid, 'SIGINT');
    }
    this._state = 'killing';
  }

  /**
   * Generates the PATH environment variable that should be set when this
   * script's command is spawned.
   */
  private get _pathEnvironmentVariable(): string {
    // Given package "/foo/bar", walk up the path hierarchy to generate
    // "/foo/bar/node_modules/.bin:/foo/node_modules/.bin:/node_modules/.bin".
    const entries = [];
    let cur = this._script.packageDir;
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
