/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import * as fs from 'fs/promises';
import * as pathlib from 'path';
import {fileURLToPath} from 'url';
import {spawn, type ChildProcess} from 'child_process';
import cmdShim from 'cmd-shim';
import {WireitTestRigCommand} from './test-rig-command.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathlib.dirname(__filename);
const repoRoot = pathlib.resolve(__dirname, '..', '..', '..');
const isWindows = process.platform === 'win32';

/**
 * A test rig for managing a temporary filesystem and executing Wireit.
 */
export class WireitTestRig {
  readonly temp = pathlib.resolve(repoRoot, 'temp', String(Math.random()));
  private _state: 'uninitialized' | 'running' | 'done' = 'uninitialized';
  private readonly _activeChildProcesses = new Set<ChildProcess>();
  private readonly _commands: Array<WireitTestRigCommand> = [];

  private _assertState(expected: 'uninitialized' | 'running' | 'done') {
    if (this._state !== expected) {
      throw new Error(
        `Expected state to be ${expected} but was ${this._state}`
      );
    }
  }

  /**
   * Initialize the temporary filesystem, and set up the wireit binary to be
   * runnable as though it had been installed there through npm.
   */
  async setup() {
    this._assertState('uninitialized');
    this._state = 'running';
    const absWireitBinaryPath = pathlib.resolve(repoRoot, 'bin', 'wireit.js');
    const absWireitTempInstallPath = pathlib.resolve(
      this.temp,
      'node_modules',
      '.bin',
      'wireit'
    );
    if (isWindows) {
      // Npm install works differently on Windows, since it won't recognize a
      // shebang like "#!/usr/bin/env node". Npm instead uses the cmd-shim
      // package to generate Windows shell wrappers for each binary, so we do
      // that here too.
      await cmdShim(absWireitBinaryPath, absWireitTempInstallPath);
    } else {
      await this.symlink(absWireitBinaryPath, absWireitTempInstallPath);
    }
  }

  /**
   * Delete the temporary filesystem and perform other cleanup.
   */
  async cleanup(): Promise<void> {
    this._assertState('running');
    this._state = 'done';
    for (const process of this._activeChildProcesses) {
      process.kill(9);
    }
    await Promise.all([
      fs.rm(this.temp, {recursive: true}),
      ...this._commands.map((command) => command.close()),
    ]);
  }

  private _resolve(filename: string): string {
    return pathlib.resolve(this.temp, filename);
  }

  /**
   * Write files to the temporary filesystem.
   *
   * If the value of an entry in the files object is a string, it is written as
   * UTF-8 text. Otherwise it is JSON encoded.
   */
  async write(files: {[filename: string]: unknown}) {
    this._assertState('running');
    await Promise.all(
      Object.entries(files).map(async ([relative, data]) => {
        const absolute = pathlib.resolve(this.temp, relative);
        await fs.mkdir(pathlib.dirname(absolute), {recursive: true});
        const str =
          typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        return fs.writeFile(absolute, str, 'utf8');
      })
    );
  }

  /**
   * Read a file from the temporary filesystem.
   */
  async read(filename: string): Promise<string> {
    this._assertState('running');
    return fs.readFile(this._resolve(filename), 'utf8');
  }

  /**
   * Check whether a file exists in the temporary filesystem.
   */
  async exists(filename: string): Promise<boolean> {
    this._assertState('running');
    try {
      await fs.access(this._resolve(filename));
      return true;
    } catch (err) {
      if ((err as {code?: string}).code === 'ENOENT') {
        return false;
      }
      throw err;
    }
  }

  /**
   * Delete a file or directory in the temporary filesystem.
   */
  async delete(filename: string): Promise<void> {
    this._assertState('running');
    await fs.rm(this._resolve(filename), {force: true, recursive: true});
  }

  /**
   * Create a symlink in the temporary filesystem.
   */
  async symlink(target: string, filename: string): Promise<void> {
    this._assertState('running');
    const absolute = this._resolve(filename);
    try {
      await fs.unlink(absolute);
    } catch (err) {
      if ((err as {code?: string}).code !== 'ENOENT') {
        throw err;
      }
      await fs.mkdir(pathlib.dirname(absolute), {recursive: true});
    }
    await fs.symlink(target, absolute);
  }

  /**
   * Evaluate the given shell command in the temporary filesystem.
   */
  exec(command: string, opts?: {cwd?: string}): ExecResult {
    this._assertState('running');
    const cwd = this._resolve(opts?.cwd ?? '.');
    const child = spawn(command, {
      cwd,
      shell: true,
      // Remove any environment variables that start with "npm_", because those
      // will have been set by the "npm test" or similar command that launched
      // this test itself, and we want a more pristine simulation of running
      // wireit directly when we're testing.
      //
      // In particular, this lets us test for the case where wireit was not
      // launched through npm at all.
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith('npm_'))
      ),
    });
    this._activeChildProcesses.add(child);
    let stdout = '';
    let stderr = '';
    const showOutput = process.env.SHOW_TEST_OUTPUT;
    child.stdout.on('data', (chunk: string | Buffer) => {
      stdout += chunk;
      if (showOutput) {
        process.stdout.write(chunk);
      }
    });
    child.stderr.on('data', (chunk: string | Buffer) => {
      stderr += chunk;
      if (showOutput) {
        process.stderr.write(chunk);
      }
    });
    const exit = new Promise<Awaited<ExecResult['exit']>>((resolve, reject) => {
      child.on('close', (code, signal) => {
        this._activeChildProcesses.delete(child);
        resolve({stdout, stderr, code, signal});
      });
      child.on('error', (error: Error) => {
        reject(error);
      });
    });
    return {exit};
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
    if (isWindows) {
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

/**
 * The result of running WireitTestRig.exec.
 */
export interface ExecResult {
  /** Promise that resolves when the child process has exited. */
  exit: Promise<{
    stdout: string;
    stderr: string;
    /** The exit code, or null if the child process exited with a signal. */
    code: number | null;
    /** The exit signal, or null if the child process did not exit with a signal. */
    signal: NodeJS.Signals | null;
  }>;
}
