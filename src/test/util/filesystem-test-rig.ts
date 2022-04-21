/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as pathlib from 'path';
import {fileURLToPath} from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathlib.dirname(__filename);
const repoRoot = pathlib.resolve(__dirname, '..', '..', '..');

/**
 * A test rig for managing a temporary filesystem.
 */
export class FilesystemTestRig {
  readonly temp = pathlib.resolve(repoRoot, 'temp', String(Math.random()));
  #state: 'uninitialized' | 'running' | 'done' = 'uninitialized';

  protected assertState(expected: 'uninitialized' | 'running' | 'done') {
    if (this.#state !== expected) {
      throw new Error(
        `Expected state to be ${expected} but was ${this.#state}`
      );
    }
  }

  /**
   * Initialize the temporary filesystem.
   */
  async setup() {
    this.assertState('uninitialized');
    this.#state = 'running';
    await this.mkdir('.');
  }

  /**
   * Delete the temporary filesystem.
   */
  async cleanup(): Promise<void> {
    this.assertState('running');
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
  async write(files: {[filename: string]: unknown}) {
    this.assertState('running');
    await Promise.all(
      Object.entries(files).map(async ([relative, data]) => {
        const absolute = pathlib.resolve(this.temp, relative);
        await fs.mkdir(pathlib.dirname(absolute), {recursive: true});
        const str =
          typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        await fs.writeFile(absolute, str, 'utf8');
      })
    );
  }

  /**
   * Read a file from the temporary filesystem.
   */
  async read(filename: string): Promise<string> {
    this.assertState('running');
    return fs.readFile(this.resolve(filename), 'utf8');
  }

  /**
   * Check whether a file exists in the temporary filesystem.
   */
  async exists(filename: string): Promise<boolean> {
    this.assertState('running');
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
   * Create an empty directory in the temporary filesystem, including all parent
   * directories.
   */
  async mkdir(dirname: string): Promise<void> {
    this.assertState('running');
    await fs.mkdir(this.resolve(dirname), {recursive: true});
  }

  /**
   * Delete a file or directory in the temporary filesystem.
   */
  async delete(filename: string): Promise<void> {
    this.assertState('running');
    await fs.rm(this.resolve(filename), {force: true, recursive: true});
  }

  /**
   * Create a symlink in the temporary filesystem.
   */
  async symlink(target: string, filename: string): Promise<void> {
    this.assertState('running');
    const absolute = this.resolve(filename);
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
}
