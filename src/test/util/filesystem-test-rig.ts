/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as pathlib from 'path';
import {fileURLToPath} from 'url';
import {gracefulFs} from './graceful-fs.js';

import type {Stats} from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathlib.dirname(__filename);
const repoRoot = pathlib.resolve(__dirname, '..', '..', '..');

/**
 * A test rig for managing a temporary filesystem.
 */
export class FilesystemTestRig {
  readonly temp = pathlib.resolve(repoRoot, 'temp', String(Math.random()));
  #state: 'uninitialized' | 'running' | 'done' = 'uninitialized';
  #donePromise: Promise<void> | undefined = undefined;

  protected _assertState(expected: 'uninitialized' | 'running' | 'done') {
    if (this.#state !== expected) {
      throw new Error(
        `Expected state to be ${expected} but was ${this.#state}`,
      );
    }
  }

  /**
   * Initialize the temporary filesystem.
   */
  async setup() {
    this._assertState('uninitialized');
    this.#state = 'running';
    await this.mkdir('.');
  }

  /**
   * Delete the temporary filesystem.
   */
  async cleanup(): Promise<void> {
    if (this.#donePromise === undefined) {
      this.#donePromise = this.#actuallyCleanup();
    }
    return this.#donePromise;
  }

  async #actuallyCleanup(): Promise<void> {
    this._assertState('running');
    await this.delete('.');
    this.#state = 'done';
  }

  /**
   * Resolve a file path relative to the temporary filesystem.
   */
  resolve(filename: string): string {
    return pathlib.resolve(this.temp, filename);
  }

  /**
   * Write files to the temporary filesystem.
   *
   * If the value of an entry in the files object is a string, it is written as
   * UTF-8 text. Otherwise it is JSON encoded.
   */
  async write(file: string, content: unknown): Promise<void>;
  async write(files: {[filename: string]: unknown}): Promise<void>;
  async write(
    fileOrFiles: string | {[filename: string]: unknown},
    data?: string,
  ): Promise<void> {
    this._assertState('running');
    if (typeof fileOrFiles === 'string') {
      const absolute = pathlib.resolve(this.temp, fileOrFiles);
      await fs.mkdir(pathlib.dirname(absolute), {recursive: true});
      const str =
        typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      await fs.writeFile(absolute, str, 'utf8');
    } else {
      await Promise.all(
        Object.entries(fileOrFiles).map(async ([relative, data]) =>
          this.write(relative, data),
        ),
      );
    }
  }

  /**
   * Like {@link write}, but first writes to a temporary file, and then renames
   * the file to its final location.
   */
  async writeAtomic(file: string, content: unknown): Promise<void>;
  async writeAtomic(files: {[filename: string]: unknown}): Promise<void>;
  async writeAtomic(
    fileOrFiles: string | {[filename: string]: unknown},
    data?: string,
  ): Promise<void> {
    this._assertState('running');
    if (typeof fileOrFiles === 'string') {
      const actual = pathlib.resolve(this.temp, fileOrFiles);
      const temp = actual + '.tmp';
      await this.write(temp, data);
      await this.rename(temp, actual);
    } else {
      await Promise.all(
        Object.entries(fileOrFiles).map(async ([relative, data]) =>
          this.writeAtomic(relative, data),
        ),
      );
    }
  }

  /**
   * Rename a file in the temporary filesystem.
   */
  async rename(oldPath: string, newPath: string): Promise<void> {
    await fs.rename(this.resolve(oldPath), this.resolve(newPath));
  }

  /**
   * Write an empty file to the temporary filesystem.
   */
  async touch(file: string): Promise<void> {
    await this.write({[file]: ''});
  }

  /**
   * Read a file from the temporary filesystem as UTF8.
   */
  async read(filename: string): Promise<string> {
    this._assertState('running');
    return fs.readFile(this.resolve(filename), 'utf8');
  }

  /**
   * Read a file from the temporary filesystem as bytes.
   */
  async readBytes(filename: string): Promise<Buffer<ArrayBufferLike>> {
    this._assertState('running');
    return fs.readFile(this.resolve(filename));
  }

  /**
   * Check whether a file exists in the temporary filesystem.
   */
  async exists(filename: string): Promise<boolean> {
    this._assertState('running');
    try {
      await fs.access(this.resolve(filename));
      return true;
    } catch (err) {
      if ((err as {code?: string}).code === 'ENOENT') {
        return false;
      }
      throw err;
    }
  }

  /**
   * Get filesystem metadata for the given path in the temporary filesystem.
   */
  async lstat(path: string): Promise<Stats> {
    this._assertState('running');
    return fs.lstat(this.resolve(path));
  }

  /**
   * Return true if the given path in the temporary filesystem is a directory.
   * Return false if it is another kind of file, or if it doesn't exit.
   */
  async isDirectory(path: string): Promise<boolean> {
    this._assertState('running');
    try {
      const stats = await this.lstat(path);
      return stats.isDirectory();
    } catch (error) {
      const {code} = error as {code: string};
      if (code === /* does not exist */ 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Read the string contents of the given symlink in the temporary filesystem,
   * or undefined if it doesn't exist.
   */
  async readlink(path: string): Promise<string | undefined> {
    this._assertState('running');
    try {
      return await fs.readlink(this.resolve(path));
    } catch (error) {
      const {code} = error as {code: string};
      if (code === /* does not exist */ 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Create an empty directory in the temporary filesystem, including all parent
   * directories.
   */
  async mkdir(dirname: string): Promise<void> {
    this._assertState('running');
    await fs.mkdir(this.resolve(dirname), {recursive: true});
  }

  /**
   * Delete a file or directory in the temporary filesystem.
   */
  async delete(filename: string): Promise<void> {
    this._assertState('running');
    return gracefulFs(() =>
      fs.rm(this.resolve(filename), {force: true, recursive: true}),
    );
  }

  /**
   * Create a symlink in the temporary filesystem.
   */
  async symlink(
    target: string,
    filename: string,
    windowsType: 'file' | 'dir' | 'junction',
  ): Promise<void> {
    this._assertState('running');
    const absolute = this.resolve(filename);
    try {
      await fs.unlink(absolute);
    } catch (err) {
      if ((err as {code?: string}).code !== 'ENOENT') {
        throw err;
      }
      await fs.mkdir(pathlib.dirname(absolute), {recursive: true});
    }
    await fs.symlink(target, absolute, windowsType);
  }
}
