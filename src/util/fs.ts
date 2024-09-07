/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Like node fs/promises, only we maintain a budget of open files to prevent
// running out of file descriptors.

import type * as fsTypes from 'fs';
import * as fs from 'fs/promises';
import {
  createReadStream as rawCreateReadStream,
  createWriteStream as rawCreateWriteStream,
} from 'fs';
import {Deferred} from './deferred.js';
import './dispose.js';
export {constants} from 'fs';

declare global {
  interface SymbolConstructor {
    readonly dispose: unique symbol;
  }
}

export class Semaphore {
  #remaining: number;
  readonly #waiting: Deferred<void>[] = [];

  constructor(numSlots: number) {
    if (numSlots <= 0) {
      throw new Error(`numSlots must be positive, got ${numSlots}`);
    }
    this.#remaining = numSlots;
  }

  async reserve(): Promise<Disposable> {
    while (this.#remaining === 0) {
      const deferred = new Deferred<void>();
      this.#waiting.push(deferred);
      await deferred.promise;
    }
    this.#remaining--;
    let disposed = false;
    return {
      [Symbol.dispose]: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        this.#remaining++;
        if (this.#waiting.length > 0) {
          this.#waiting.pop()?.resolve();
        }
      },
    };
  }
}

export const fileBudget = (() => {
  let maxOpenFiles = Number(process.env['WIREIT_MAX_OPEN_FILES']);
  if (isNaN(maxOpenFiles)) {
    // This is tricky to get right. There's no simple cross-platform way to
    // determine what our current limits are. Windows it's 512, on macOS it
    // defaults to 256, and on Linux it varies a lot.
    // 200 gives us a bit of headroom for other things that might be using
    // file descriptors in our process, like node internals.
    maxOpenFiles = 200;
  }
  return new Semaphore(maxOpenFiles);
})();

export async function mkdir(
  path: string,
  options?: fsTypes.MakeDirectoryOptions & {recursive: boolean},
): Promise<string | undefined> {
  const reservation = await fileBudget.reserve();
  try {
    return await fs.mkdir(path, options);
  } finally {
    reservation[Symbol.dispose]();
  }
}

export async function mkdtemp(path: string): Promise<string> {
  const reservation = await fileBudget.reserve();
  try {
    return await fs.mkdtemp(path);
  } finally {
    reservation[Symbol.dispose]();
  }
}

export async function writeFile(
  path: string,
  contents: string,
  encoding: 'utf8',
): Promise<void> {
  const reservation = await fileBudget.reserve();
  try {
    return await fs.writeFile(path, contents, encoding);
  } finally {
    reservation[Symbol.dispose]();
  }
}

export async function readFile(
  path: string,
  encoding: 'utf8',
): Promise<string> {
  const reservation = await fileBudget.reserve();
  try {
    return await fs.readFile(path, encoding);
  } finally {
    reservation[Symbol.dispose]();
  }
}

export async function rm(
  path: string,
  options: fsTypes.RmOptions,
): Promise<void> {
  const reservation = await fileBudget.reserve();
  try {
    return await fs.rm(path, options);
  } finally {
    reservation[Symbol.dispose]();
  }
}

export async function lstat(path: string): Promise<fsTypes.Stats> {
  const reservation = await fileBudget.reserve();
  try {
    return await fs.lstat(path);
  } finally {
    reservation[Symbol.dispose]();
  }
}

export async function stat(path: string): Promise<fsTypes.Stats> {
  const reservation = await fileBudget.reserve();
  try {
    return await fs.stat(path);
  } finally {
    reservation[Symbol.dispose]();
  }
}

export async function access(path: string): Promise<void> {
  const reservation = await fileBudget.reserve();
  try {
    return await fs.access(path);
  } finally {
    reservation[Symbol.dispose]();
  }
}

type ReadStreamOptions =
  | BufferEncoding
  | {
      flags?: string | undefined;
      encoding?: BufferEncoding | undefined;
      fd?: number | undefined;
      mode?: number | undefined;
      autoClose?: boolean | undefined;
      /**
       * @default false
       */
      emitClose?: boolean | undefined;
      start?: number | undefined;
      end?: number | undefined;
      highWaterMark?: number | undefined;
    };

export async function createReadStream(
  path: string,
  options?: ReadStreamOptions,
): Promise<fsTypes.ReadStream> {
  const reservation = await fileBudget.reserve();
  const stream = rawCreateReadStream(path, options);
  stream.on('close', () => reservation[Symbol.dispose]());
  return stream;
}

export async function createWriteStream(
  path: string,
): Promise<fsTypes.WriteStream> {
  const reservation = await fileBudget.reserve();
  const stream = rawCreateWriteStream(path);
  stream.on('close', () => reservation[Symbol.dispose]());
  return stream;
}

export async function copyFile(
  src: fsTypes.PathLike,
  dest: fsTypes.PathLike,
  flags?: number | undefined,
) {
  const reservation = await fileBudget.reserve();
  try {
    return await fs.copyFile(src, dest, flags);
  } finally {
    reservation[Symbol.dispose]();
  }
}

export function readlink(
  path: fsTypes.PathLike,
  options?: BufferEncoding | null,
): Promise<string>;
export function readlink(
  path: fsTypes.PathLike,
  options?: {encoding: 'buffer'},
): Promise<Buffer>;
export async function readlink(
  path: fsTypes.PathLike,
  options?: {encoding: 'buffer'} | BufferEncoding | null,
): Promise<string | Buffer> {
  const reservation = await fileBudget.reserve();
  try {
    return await fs.readlink(path, options as BufferEncoding);
  } finally {
    reservation[Symbol.dispose]();
  }
}

export async function symlink(
  target: fsTypes.PathLike,
  path: fsTypes.PathLike,
  type?: string | null,
) {
  const reservation = await fileBudget.reserve();
  try {
    return await fs.symlink(target, path, type);
  } finally {
    reservation[Symbol.dispose]();
  }
}

export async function unlink(target: string) {
  const reservation = await fileBudget.reserve();
  try {
    return await fs.unlink(target);
  } finally {
    reservation[Symbol.dispose]();
  }
}

export async function rmdir(target: string) {
  const reservation = await fileBudget.reserve();
  try {
    return await fs.rmdir(target);
  } finally {
    reservation[Symbol.dispose]();
  }
}

export async function readdir(
  path: string,
  options: {withFileTypes: true},
): Promise<fsTypes.Dirent[]> {
  using _reservation = await fileBudget.reserve();
  return await fs.readdir(path, options);
}
