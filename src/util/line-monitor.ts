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
  private readonly _child: ScriptChildProcess;
  private readonly _pattern: RegExp;
  private readonly _matched = new Deferred<Result<void, void>>();
  private _stdout = '';
  private _stderr = '';

  /**
   * Resolves to `{"ok": true}` when a match was found or `{"ok": false}` when
   * this monitor was aborted.
   */
  readonly matched = this._matched.promise;

  constructor(child: ScriptChildProcess, pattern: RegExp) {
    this._child = child;
    this._pattern = pattern;
    child.stdout.on('data', this._onStdout);
    child.stderr.on('data', this._onStderr);
  }

  abort() {
    this._removeEventListeners();
    this._matched.resolve({ok: false, error: undefined});
  }

  private _removeEventListeners() {
    this._child.stdout.removeListener('data', this._onStdout);
    this._child.stderr.removeListener('data', this._onStderr);
  }

  private _onStdout = (data: string | Buffer) => {
    this._stdout = this._check(this._stdout + String(data));
  };

  private _onStderr = (data: string | Buffer) => {
    this._stderr = this._check(this._stderr + String(data));
  };

  private _check(buffer: string): string {
    const lines = buffer.split(/\n/g);
    let end = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i !== lines.length - 1) {
        // Don't move beyond the final line, since it might be incomplete, and
        // we want to match the entire line the next time _check is called.
        end += line.length + 1;
      }
      if (this._pattern.test(line)) {
        this._removeEventListeners();
        this._matched.resolve({ok: true, value: undefined});
        break;
      }
    }
    return buffer.slice(end);
  }
}
