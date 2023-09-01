/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Deferred} from './deferred.js';

import type {ScriptChildProcess} from '../script-child-process.js';
import type {Result} from '../error.js';

/**
 * Monitors the stdout and stderr of a child process line-by-line searching for
 * a match of the given regular expression.
 *
 * Note we can't use readline here because we want to check lines that haven't
 * completed yet.
 */
export class LineMonitor {
  readonly #child: ScriptChildProcess;
  readonly #pattern: RegExp;
  readonly #matched = new Deferred<Result<void, void>>();
  #stdout = '';
  #stderr = '';

  /**
   * Resolves to `{"ok": true}` when a match was found or `{"ok": false}` when
   * this monitor was aborted.
   */
  readonly matched = this.#matched.promise;

  constructor(child: ScriptChildProcess, pattern: RegExp) {
    this.#child = child;
    this.#pattern = pattern;
    child.stdout.on('data', this.#onStdout);
    child.stderr.on('data', this.#onStderr);
  }

  abort() {
    this.#removeEventListeners();
    this.#matched.resolve({ok: false, error: undefined});
  }

  #removeEventListeners() {
    this.#child.stdout.removeListener('data', this.#onStdout);
    this.#child.stderr.removeListener('data', this.#onStderr);
  }

  #onStdout = (data: string | Buffer) => {
    this.#stdout = this.#check(this.#stdout + String(data));
  };

  #onStderr = (data: string | Buffer) => {
    this.#stderr = this.#check(this.#stderr + String(data));
  };

  #check(buffer: string): string {
    const lines = buffer.split(/\n/g);
    let end = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (i !== lines.length - 1) {
        // Don't move beyond the final line, since it might be incomplete, and
        // we want to match the entire line the next time _check is called.
        end += line.length + 1;
      }
      if (this.#pattern.test(line)) {
        this.#removeEventListeners();
        this.#matched.resolve({ok: true, value: undefined});
        break;
      }
    }
    return buffer.slice(end);
  }
}
