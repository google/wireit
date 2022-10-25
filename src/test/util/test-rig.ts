/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as pathlib from 'path';
import {fileURLToPath} from 'url';
import {spawn, type ChildProcessWithoutNullStreams} from 'child_process';
import cmdShim from 'cmd-shim';
import {WireitTestRigCommand} from './test-rig-command.js';
import {Deferred} from '../../util/deferred.js';
import {
  IS_WINDOWS,
  augmentProcessEnvSafelyIfOnWindows,
} from '../../util/windows.js';
import {FilesystemTestRig} from './filesystem-test-rig.js';
import {NODE_MAJOR_VERSION} from './node-version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathlib.dirname(__filename);
const repoRoot = pathlib.resolve(__dirname, '..', '..', '..');

/**
 * A test rig for managing a temporary filesystem and executing Wireit.
 */
export class WireitTestRig extends FilesystemTestRig {
  private readonly _activeChildProcesses = new Set<ExecResult>();
  private readonly _commands: Array<WireitTestRigCommand> = [];

  /**
   * Environment variables to set on spawned child processes.
   */
  env: Record<string, string | undefined> = {};

  /**
   * Initialize the temporary filesystem, and set up the wireit binary to be
   * runnable as though it had been installed there through npm.
   */
  override async setup() {
    await super.setup();
    const absWireitBinaryPath = pathlib.resolve(repoRoot, 'bin', 'wireit.js');
    const absWireitTempInstallPath = pathlib.resolve(
      this.temp,
      'node_modules',
      '.bin',
      'wireit'
    );
    if (IS_WINDOWS) {
      // Npm install works differently on Windows, since it won't recognize a
      // shebang like "#!/usr/bin/env node". Npm instead uses the cmd-shim
      // package to generate Windows shell wrappers for each binary, so we do
      // that here too.
      await cmdShim(absWireitBinaryPath, absWireitTempInstallPath);
    } else {
      await this.symlink(absWireitBinaryPath, absWireitTempInstallPath, 'file');
    }
  }

  /**
   * Generates and installs a Node binary which invokes the given command. On
   * Linux/macOS, this is performed with a symlink. On Windows, it is performed
   * with the special cmd-shim package.
   *
   * @param command The command that the binary should invoke.
   * @param actualBinaryPath Path to the binary that is being installed (e.g.
   * "node_modules/foo/bin/bar")
   * @param installPath Path to the location where the binary will be installed
   * (e.g. "node_modules/.bin/bar")
   */
  async generateAndInstallNodeBinary({
    command,
    binaryPath,
    installPath,
  }: {
    command: string;
    binaryPath: string;
    installPath: string;
  }) {
    this._assertState('running');

    binaryPath = this._resolve(binaryPath);
    installPath = this._resolve(installPath);
    const binaryContent = IS_WINDOWS
      ? // This incantation works on Windows but not Linux, because real "env"
        // requires an "-S" flag to pass arguments to a binary, but cmd-shim
        // doesn't handle that correctly (see
        // https://github.com/npm/cmd-shim/issues/54).
        `#!/usr/bin/env ${command}`
      : // This incantation works on Linux and macOS, but not Windows.
        // "#!/usr/bin/env -S <command>" also works on Linux, but not macOS
        // (unsure why).
        `#!/bin/sh\n${command}`;

    await fs.mkdir(pathlib.dirname(binaryPath), {recursive: true});
    await fs.writeFile(binaryPath, binaryContent, {
      encoding: 'utf8',
      mode: 0o777,
    });

    await fs.mkdir(pathlib.dirname(installPath), {recursive: true});
    if (IS_WINDOWS) {
      await cmdShim(binaryPath, installPath);
    } else {
      await this.symlink(binaryPath, installPath, 'file');
    }
  }

  /**
   * Delete the temporary filesystem and perform other cleanup.
   */
  override async cleanup(): Promise<void> {
    await Promise.all(this._commands.map((command) => command.close()));
    for (const child of this._activeChildProcesses) {
      child.kill();
      await child.exit;
    }
    await super.cleanup();
  }

  private _resolve(filename: string): string {
    return pathlib.resolve(this.temp, filename);
  }

  /**
   * Evaluate the given shell command in the temporary filesystem.
   */
  exec(
    command: string,
    opts?: {cwd?: string; env?: Record<string, string | undefined>}
  ): ExecResult {
    this._assertState('running');
    const cwd = this._resolve(opts?.cwd ?? '.');
    const result = new ExecResult(command, cwd, {
      // We hard code the parallelism here because by default we infer a value
      // based on the number of cores we find on the machine, but we want tests
      // to behave as consistently as possible across machines.
      WIREIT_PARALLEL: '10',
      // GitHub Actions sets CI=true, but we want our tests to act like they are
      // running locally by default, even when they are actually running on CI.
      CI: undefined,
      // Unset GitHub Actions caching environment variables that are set when we
      // are running these tests in CI.
      WIREIT_CACHE: undefined,
      WIREIT_FAILURES: undefined,
      ACTIONS_CACHE_URL: undefined,
      ACTIONS_RUNTIME_TOKEN: undefined,
      // In npm 6 (which ships with Node 14), "npm run" only includes the
      // immediate package's "node_modules/.bin" directory in $PATH. Above npm
      // 6, all of the parent ".bin" directories are included too.
      //
      // Some of our tests rely on the newer behavior, because they execute "npm
      // run" from a child package, and assume that the "wireit" binary that we
      // install to the root of the temp directory will be available. We also
      // need access to "yarn" and "pnpm", which are installed as
      // devDependencies of the root Wireit package.
      //
      // So, we have to add both of those "node_modules/.bin" directories to the
      // $PATH to make those tests work.
      PATH:
        NODE_MAJOR_VERSION > 14
          ? process.env.PATH
          : [
              pathlib.join(this.temp, 'node_modules', '.bin'),
              pathlib.join(repoRoot, 'node_modules', '.bin'),
              process.env.PATH ?? '',
            ].join(pathlib.delimiter),
      // Environment variables specific to this TestRig instance.
      ...this.env,
      // Environment variables specific to this test case.
      ...(opts?.env ?? {}),
    });
    this._activeChildProcesses.add(result);
    result.exit.finally(() => this._activeChildProcesses.delete(result));
    return result;
  }

  /**
   * Create a new test command.
   */
  async newCommand(): Promise<WireitTestRigCommand> {
    this._assertState('running');
    // On Windows, Node IPC is implemented with named pipes, which must be
    // prefixed by "\\?\pipe\". On Linux/macOS it's a unix domain socket, which
    // can be any filepath. See https://nodejs.org/api/net.html#ipc-support for
    // more details.
    let ipcPath: string;
    if (IS_WINDOWS) {
      ipcPath = pathlib.join(
        '\\\\?\\pipe',
        this.temp,
        Math.random().toString()
      );
    } else {
      ipcPath = pathlib.resolve(
        this.temp,
        '__sockets',
        Math.random().toString()
      );
      // The socket file will be created on the net.createServer call, but the
      // parent directory must exist.
      await fs.mkdir(pathlib.dirname(ipcPath), {recursive: true});
    }
    const command = new WireitTestRigCommand(ipcPath);
    this._commands.push(command);
    await command.listen();
    return command;
  }
}

export type {ExecResult};

/**
 * The object returned by {@link WireitTestRig.exec}.
 */
class ExecResult {
  private readonly _child: ChildProcessWithoutNullStreams;
  private readonly _exited = new Deferred<ExitResult>();
  private _running = true;
  private _stdout = '';
  private _stderr = '';

  constructor(
    command: string,
    cwd: string,
    env: Record<string, string | undefined>
  ) {
    // Remove any environment variables that start with "npm_", because those
    // will have been set by the "npm test" or similar command that launched
    // this test itself, and we want a more pristine simulation of running
    // wireit directly when we're testing.
    //
    // In particular, this lets us test for the case where wireit was not
    // launched through npm at all.
    const unsetNpmVariables = Object.fromEntries(
      Object.keys(process.env)
        .filter((name) => /^npm_/i.test(name))
        .map((name) => [name, undefined])
    );
    this._child = spawn(command, {
      cwd,
      shell: true,
      env: augmentProcessEnvSafelyIfOnWindows({
        ...unsetNpmVariables,
        ...env,
      }),
      // Set "detached" on Linux and macOS so that we create a new process
      // group, instead of inheriting the parent process group. We need a new
      // process group so that we can use a "kill(-pid)" command to kill all of
      // the processes in the process group, instead of just the top one. Our
      // process is not the top one because it is a child of "sh", and "sh" does
      // not forward signals to child processes, so a regular "kill(pid)" would
      // do nothing. The process is a child of "sh" because we are using the
      // "shell" option.
      //
      // On Windows this works completely differently, and we instead kill child
      // processes with "taskkill". If we set "detached" on Windows, it has the
      // side effect of causing all child processes to open in new terminal
      // windows.
      detached: !IS_WINDOWS,
    });

    this._child.stdout.on('data', this._onStdout);
    this._child.stderr.on('data', this._onStderr);

    this._child.on('close', (code, signal) => {
      this._running = false;
      this._exited.resolve({
        code,
        signal,
        stdout: this._stdout,
        stderr: this._stderr,
      });
    });

    this._child.on('error', (error: Error) => {
      this._exited.reject(error);
    });
  }

  /**
   * Whether this child process is still running.
   */
  get running(): boolean {
    return this._running;
  }

  /**
   * Promise that resolves when this child process exits with information about
   * the execution.
   */
  get exit(): Promise<ExitResult> {
    return this._exited.promise;
  }

  /**
   * Kill the child process.
   */
  kill(): void {
    if (!this.running) {
      throw new Error("Can't kill child process because it is not running");
    }
    if (this._child.pid === undefined) {
      throw new Error("Can't kill child process because it has no pid");
    }
    if (IS_WINDOWS) {
      // Windows doesn't have signals. Node ChildProcess.kill() sort of emulates
      // the behavior of SIGKILL (and ignores the signal you pass in), but it
      // seems to leave streams and file handles open. The taskkill command does
      // a much better job at cleanly killing the process:
      // https://docs.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill
      spawn('taskkill', ['/pid', this._child.pid.toString(), '/t', '/f']);
    } else {
      // We used "detached" when we spawned, so our child is the leader of its
      // own process group. Passing the negative of the child's pid kills all
      // processes in the group (without the negative only the leader "sh"
      // process would be killed).
      process.kill(-this._child.pid, 'SIGINT');
    }
  }

  private readonly _logMatchers: Array<{re: RegExp; deferred: Deferred<void>}> =
    [];

  /**
   * Waits for the given content to be logged to either stdout or stderr.
   *
   * When it does, it consumes all stdout or stderr that's been emitted up to
   * that match so far.
   */
  waitForLog(matcher: RegExp): Promise<void> {
    const deferred = new Deferred<void>();
    this._logMatchers.push({re: matcher, deferred});
    // In case we've already received the log we're watching for
    this._checkMatchersAgainstLogs();
    return deferred.promise;
  }

  private _checkMatchersAgainstLogs() {
    let stdoutLastIndex = -1;
    let stderrLastIndex = -1;
    for (const {re, deferred} of this._logMatchers) {
      if (re.test(this._stdout)) {
        deferred.resolve();
        stdoutLastIndex = Math.max(stdoutLastIndex, re.lastIndex);
      } else if (re.test(this._stderr)) {
        stderrLastIndex = Math.max(stderrLastIndex, re.lastIndex);
        deferred.resolve();
      }
    }
    if (stdoutLastIndex > 0) {
      this._stdout = this._stdout.slice(stdoutLastIndex);
    }
    if (stderrLastIndex > 0) {
      this._stderr = this._stderr.slice(stderrLastIndex);
    }
  }

  private readonly _onStdout = (chunk: string | Buffer) => {
    this._stdout += chunk;
    if (process.env.SHOW_TEST_OUTPUT) {
      process.stdout.write(chunk);
    }
    this._checkMatchersAgainstLogs();
  };

  private readonly _onStderr = (chunk: string | Buffer) => {
    this._stderr += chunk;
    if (process.env.SHOW_TEST_OUTPUT) {
      process.stdout.write(chunk);
    }
    this._checkMatchersAgainstLogs();
  };
}

/**
 * The result of {@link ExecResult.exit}.
 */
export interface ExitResult {
  stdout: string;
  stderr: string;
  /** The exit code, or null if the child process exited with a signal. */
  code: number | null;
  /** The exit signal, or null if the child process did not exit with a signal. */
  signal: NodeJS.Signals | null;
}
