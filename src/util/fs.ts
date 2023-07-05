// Like node fs/promises, only we maintain a budget of open files to prevent
// running out of file descriptors.

import type * as fsTypes from 'fs';
import * as fs from 'fs/promises';
import {
  createReadStream as rawCreateReadStream,
  createWriteStream as rawCreateWriteStream,
} from 'fs';
import {Deferred} from './deferred.js';
export {constants} from 'fs';
export type * from 'fs';

declare global {
  interface SymbolConstructor {
    readonly dispose: unique symbol;
    readonly asyncDispose: unique symbol;
  }
}

interface Disposable {
  [Symbol.dispose](): void;
}

(Symbol as any).dispose ??= Symbol('Symbol.dispose');
(Symbol as any).asyncDispose ??= Symbol('Symbol.asyncDispose');

let maxOpenFiles = Number(process.env['WIREIT_MAX_OPEN_FILES']);
if (isNaN(maxOpenFiles)) {
  maxOpenFiles = 4000;
}

export function setMaxOpenFiles(n: number): void {
  maxOpenFiles = n;
}

export const reserveFileBudget = (() => {
  let openFiles = 0;
  let waiting: Deferred<void>[] = [];
  async function reserveFileBudget(): Promise<Disposable> {
    while (openFiles + 1 > maxOpenFiles) {
      const deferred = new Deferred<void>();
      waiting.push(deferred);
      await deferred.promise;
    }
    openFiles++;
    let disposed = false;
    return {
      [Symbol.dispose]() {
        if (disposed) {
          return;
        }
        disposed = true;
        openFiles--;
        if (waiting.length > 0) {
          waiting.pop()?.resolve();
        }
      },
    };
  }
  return reserveFileBudget;
})();

export async function mkdir(
  path: string,
  options?: fsTypes.MakeDirectoryOptions & {recursive: boolean}
): Promise<string | undefined> {
  const budget = await reserveFileBudget();
  try {
    return fs.mkdir(path, options);
  } finally {
    budget[Symbol.dispose]();
  }
}

export async function mkdtemp(path: string): Promise<string> {
  const budget = await reserveFileBudget();
  try {
    return fs.mkdtemp(path);
  } finally {
    budget[Symbol.dispose]();
  }
}

export async function writeFile(
  path: string,
  contents: string,
  encoding: 'utf8'
): Promise<void> {
  const budget = await reserveFileBudget();
  try {
    return fs.writeFile(path, contents, encoding);
  } finally {
    budget[Symbol.dispose]();
  }
}

export async function readFile(
  path: string,
  encoding: 'utf8'
): Promise<string> {
  const budget = await reserveFileBudget();
  try {
    return fs.readFile(path, encoding);
  } finally {
    budget[Symbol.dispose]();
  }
}

export async function rm(
  path: string,
  options: fsTypes.RmOptions
): Promise<void> {
  const budget = await reserveFileBudget();
  try {
    return fs.rm(path, options);
  } finally {
    budget[Symbol.dispose]();
  }
}

export async function lstat(path: string): Promise<fsTypes.Stats> {
  const budget = await reserveFileBudget();
  try {
    return fs.lstat(path);
  } finally {
    budget[Symbol.dispose]();
  }
}

export async function stat(path: string): Promise<fsTypes.Stats> {
  const budget = await reserveFileBudget();
  try {
    return fs.stat(path);
  } finally {
    budget[Symbol.dispose]();
  }
}

export async function access(path: string): Promise<void> {
  const budget = await reserveFileBudget();
  try {
    return fs.access(path);
  } finally {
    budget[Symbol.dispose]();
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
  options?: ReadStreamOptions
): Promise<fsTypes.ReadStream> {
  const budget = await reserveFileBudget();
  const stream = rawCreateReadStream(path, options);
  stream.on('close', () => budget[Symbol.dispose]());
  return stream;
}

export async function createWriteStream(
  path: string
): Promise<fsTypes.WriteStream> {
  const budget = await reserveFileBudget();
  const stream = rawCreateWriteStream(path);
  stream.on('close', () => budget[Symbol.dispose]());
  return stream;
}

export async function copyFile(
  src: fsTypes.PathLike,
  dest: fsTypes.PathLike,
  flags?: number | undefined
) {
  const budget = await reserveFileBudget();
  try {
    return await fs.copyFile(src, dest, flags);
  } finally {
    budget[Symbol.dispose]();
  }
}

export function readlink(
  path: fsTypes.PathLike,
  options?: fsTypes.BaseEncodingOptions | BufferEncoding | null
): Promise<string>;
export function readlink(
  path: fsTypes.PathLike,
  options: fsTypes.BufferEncodingOption
): Promise<Buffer>;
export async function readlink(
  path: fsTypes.PathLike,
  options?:
    | fsTypes.BaseEncodingOptions
    | fsTypes.BufferEncodingOption
    | string
    | null
): Promise<string | Buffer> {
  const budget = await reserveFileBudget();
  try {
    return await fs.readlink(path, options as any);
  } finally {
    budget[Symbol.dispose]();
  }
}

export async function symlink(target: fsTypes.PathLike, path: fsTypes.PathLike, type?: string|null) {
const budget = await reserveFileBudget();
try {
  return await fs.symlink(target, path, type);
} finally {
  budget[Symbol.dispose]();
}
}

export async function unlink(target: string) {
const budget = await reserveFileBudget();
try {
  return await fs.unlink(target);
} finally {
  budget[Symbol.dispose]();
}
}

export async function rmdir(target: string) {
  const budget = await reserveFileBudget();
  try {
    return await fs.rmdir(target);
  } finally {
    budget[Symbol.dispose]();
  }
}


