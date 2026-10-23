/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createRequire, syncBuiltinESMExports} from 'module';
import {Deferred} from '../../util/deferred.js';

type AsyncFunction = (...args: unknown[]) => Promise<unknown>;

/**
 * The exports object of "fs/promises". After a function on it is replaced,
 * syncBuiltinESMExports makes every `import * as fs from 'fs/promises'` see the
 * replacement, including the one in Wireit's src/util/fs.ts.
 */
const fsPromises = createRequire(import.meta.url)('fs/promises') as Record<
  string,
  AsyncFunction
>;

export interface FsGateOptions {
  /**
   * The "fs/promises" functions to gate, such as "unlink". Each must take a
   * path as its first argument.
   */
  readonly functions: readonly string[];

  /** The calls to gate, matched against their path argument. */
  readonly path: RegExp;

  /**
   * Makes gated calls fail at once with an error that has this code, such as
   * "EBUSY", instead of waiting for {@link FsGate.release}.
   */
  readonly failWith?: string;

  /** Called at the start of each gated call. */
  readonly onCall?: (numCalls: number) => void;
}

/**
 * Takes control of calls to functions of "fs/promises" on matching paths, in
 * this process. Each gated call waits until {@link release}, or fails, as
 * {@link FsGateOptions.failWith} says. A test can then act while a file system
 * operation is in progress, or make one fail, without a slow or broken file
 * system. Disposing restores the original functions.
 *
 * To gate calls in a Wireit process that a test starts, use gateWireitFs in
 * wireit-fs-gate.ts.
 */
export class FsGate implements Disposable {
  readonly #originals = new Map<string, AsyncFunction>();
  readonly #firstCall = new Deferred<void>();
  readonly #released = new Deferred<void>();
  #numCalls = 0;

  constructor(options: FsGateOptions) {
    for (const name of options.functions) {
      const original = fsPromises[name];
      if (original === undefined) {
        throw new Error(`fs/promises has no function ${JSON.stringify(name)}`);
      }
      this.#originals.set(name, original);
      fsPromises[name] = async (path: unknown, ...rest: unknown[]) => {
        if (options.path.test(String(path))) {
          this.#numCalls++;
          options.onCall?.(this.#numCalls);
          if (!this.#firstCall.settled) {
            this.#firstCall.resolve();
          }
          if (options.failWith !== undefined) {
            throw Object.assign(
              new Error(
                `${options.failWith}: failed by FsGate, ${name} '${String(path)}'`,
              ),
              {code: options.failWith},
            );
          }
          await this.#released.promise;
        }
        return original(path, ...rest);
      };
    }
    syncBuiltinESMExports();
  }

  /** Resolves when the first gated call starts. */
  get firstCall(): Promise<void> {
    return this.#firstCall.promise;
  }

  /** The number of gated calls so far, held or not. */
  get numCalls(): number {
    return this.#numCalls;
  }

  /** Lets the held calls run, and every later call run without waiting. */
  release(): void {
    if (!this.#released.settled) {
      this.#released.resolve();
    }
  }

  [Symbol.dispose](): void {
    this.release();
    for (const [name, original] of this.#originals) {
      fsPromises[name] = original;
    }
    syncBuiltinESMExports();
  }
}
