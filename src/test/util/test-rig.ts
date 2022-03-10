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

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathlib.dirname(__filename);
const repoRoot = pathlib.resolve(__dirname, '..', '..', '..');
const isWindows = process.platform === 'win32';

/**
 * A test rig for managing a temporary filesystem and executing Wireit.
 */
export class WireitTestRig {
  private _done = false;
  private readonly _temp = pathlib.join(
    repoRoot,
    'temp',
    String(Math.random())
  );
  private readonly _activeChildProcesses = new Set<ChildProcess>();

  /**
   * Initialize the temporary filesystem, and set up the wireit binary to be
   * runnable as though it had been installed there through npm.
   */
  async setup() {
    const absWireitBinaryPath = pathlib.resolve(repoRoot, 'bin', 'wireit.js');
    const absWireitTempInstallPath = pathlib.resolve(
      this._temp,
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
    this._checkNotDone();
    this._done = true;
    for (const process of this._activeChildProcesses) {
      process.kill(9);
    }
    await fs.rm(this._temp, {recursive: true});
  }

  private _checkNotDone() {
    if (this._done) {
      throw new Error('WireitTestRig has already finished');
    }
  }

  private _resolve(filename: string): string {
    return pathlib.resolve(this._temp, filename);
  }

  /**
   * Write files to the temporary filesystem.
   *
   * If the value of an entry in the files object is a string, it is written as
   * UTF-8 text. Otherwise it is JSON encoded.
   */
  async write(files: {[filename: string]: unknown}) {
    this._checkNotDone();
    await Promise.all(
      Object.entries(files).map(async ([relative, data]) => {
        const absolute = pathlib.resolve(this._temp, relative);
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
    return fs.readFile(this._resolve(filename), 'utf8');
  }

  /**
   * Check whether a file exists in the temporary filesystem.
   */
  async exists(filename: string): Promise<boolean> {
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
    await fs.rm(this._resolve(filename), {force: true, recursive: true});
  }

  /**
   * Create a symlink in the temporary filesystem.
   */
  async symlink(target: string, filename: string): Promise<void> {
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
    this._checkNotDone();
    const cwd = this._resolve(opts?.cwd ?? '.');
    const child = spawn(command, {
      cwd,
      shell: true,
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
