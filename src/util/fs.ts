/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Like node fs/promises, only we maintain a budget of open files to prevent
// running out of file descriptors.

import type * as fsTypes from 'fs';
import * as fs from 'fs/promises';
import * as pathlib from 'path';
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

export async function utimes(
  path: string,
  atime: Date,
  mtime: Date,
): Promise<void> {
  using _reservation = await fileBudget.reserve();
  return await fs.utimes(path, atime, mtime);
}

export async function rename(oldPath: string, newPath: string): Promise<void> {
  using _reservation = await fileBudget.reserve();
  return await fs.rename(oldPath, newPath);
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
  flags?: number,
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

/**
 * Deletes a file or a folder tree, like fs.rm with recursive and force, but
 * stops when the signal aborts. fs.rm takes no signal, so it can't stop part
 * way through a large tree.
 *
 * Deletes in parallel, up to the open file budget, because deleting one file
 * at a time was several times slower than fs.rm. The signal is checked after
 * each slot is reserved, so after an abort only the deletions already running
 * finish. The promise then rejects with the signal's reason.
 *
 * @param options.maxConcurrent The most calls to have in flight at once, if
 * fewer than the open file budget. Node runs file system calls on a pool of 4
 * threads by default, in the order they are made. Every other file system call
 * in the process waits behind the deletions already in flight, which on a slow
 * disk can take seconds when there are hundreds.
 */
export async function rmTree(
  path: string,
  {signal, maxConcurrent}: {signal?: AbortSignal; maxConcurrent?: number} = {},
): Promise<void> {
  const context: RmTreeContext = {
    signal,
    slots:
      maxConcurrent === undefined ? undefined : new Semaphore(maxConcurrent),
  };
  let stats;
  try {
    stats = await reserveUnlessAborted(context, () => fs.lstat(path));
  } catch (error) {
    if (isMissing(error)) {
      return;
    }
    throw error;
  }
  await rmTreeEntry(path, stats.isDirectory(), context);
}

interface RmTreeContext {
  readonly signal: AbortSignal | undefined;
  readonly slots: Semaphore | undefined;
}

async function rmTreeEntry(
  path: string,
  isDirectory: boolean,
  context: RmTreeContext,
): Promise<void> {
  try {
    if (!isDirectory) {
      await reserveUnlessAborted(context, async () => {
        try {
          await fs.unlink(path);
        } catch (error) {
          if (isMissing(error)) {
            throw error;
          }
          // On Windows, fs.rm retries an EPERM, such as from a read-only file,
          // after making the file writable.
          await fs.rm(path, {force: true});
        }
      });
      return;
    }
    const children = await reserveUnlessAborted(context, () =>
      fs.readdir(path, {withFileTypes: true}),
    );
    // allSettled, so that this doesn't return while the siblings of a failed
    // child are still being deleted.
    const results = await Promise.allSettled(
      children.map((child) =>
        rmTreeEntry(
          pathlib.join(path, child.name),
          child.isDirectory(),
          context,
        ),
      ),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure !== undefined) {
      throw failure.reason;
    }
    await reserveUnlessAborted(context, () => fs.rmdir(path));
  } catch (error) {
    // Something else, such as another Wireit process, deleted it first.
    if (!isMissing(error)) {
      throw error;
    }
  }
}

async function reserveUnlessAborted<T>(
  context: RmTreeContext,
  operation: () => Promise<T>,
): Promise<T> {
  using _slot = await context.slots?.reserve();
  using _reservation = await fileBudget.reserve();
  context.signal?.throwIfAborted();
  return await operation();
}

const isMissing = (error: unknown) =>
  (error as {code?: string}).code === 'ENOENT';
