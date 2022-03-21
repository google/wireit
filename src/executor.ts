/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {spawn} from 'child_process';
import {WireitError} from './error.js';
import {configReferenceToString} from './script.js';

import type {ScriptConfig} from './script.js';
import type {Logger} from './logging/logger.js';

/**
 * Executes a script that has been analyzed and validated by the Analyzer.
 */
export class Executor {
  private readonly _cache = new Map<string, Promise<void>>();
  private readonly _logger: Logger;

  constructor(logger: Logger) {
    this._logger = logger;
  }

  async execute(script: ScriptConfig): Promise<void> {
    const cacheKey = configReferenceToString(script);
    let promise = this._cache.get(cacheKey);
    if (promise === undefined) {
      promise = this._execute(script);
      this._cache.set(cacheKey, promise);
    }
    return promise;
  }

  private async _execute(script: ScriptConfig): Promise<void> {
    // Handle all dependencies first. Note that we use Promise.allSettled
    // instead of Promise.all so that we can collect all errors, instead of just
    // the first one.
    const dependencyResults = await Promise.allSettled(
      script.dependencies.map((dependency) => this.execute(dependency))
    );
    const errors: unknown[] = [];
    for (const result of dependencyResults) {
      if (result.status === 'rejected') {
        const error: unknown = result.reason;
        if (error instanceof AggregateError) {
          // Flatten nested AggregateErrors.
          errors.push(...(error.errors as unknown[]));
        } else {
          errors.push(error);
        }
      }
    }
    if (errors.length > 0) {
      throw errors.length === 1 ? errors[0] : new AggregateError(errors);
    }

    // TODO(aomarks) Implement freshness checking.
    // TODO(aomarks) Implement output deletion.
    // TODO(aomarks) Implement caching.

    // It's valid to not have a command defined, since thats a useful way to
    // name a group of commands. In this case, we can return early.
    if (!script.command) {
      this._logger.log({
        script,
        type: 'success',
        reason: 'no-command',
      });
      return;
    }

    this._logger.log({
      script,
      type: 'info',
      detail: 'running',
    });

    // TODO(aomarks) Fix PATH and npm_ environment variables to reflect the new
    // package when cross-package dependencies are supported.

    const child = spawn(script.command, {
      cwd: script.packageDir,
      // Conveniently, "shell:true" has the same shell-selection behavior as
      // "npm run", where on macOS and Linux it is "sh", and on Windows it is
      // %COMSPEC% || "cmd.exe".
      //
      // References:
      //   https://nodejs.org/api/child_process.html#child_processspawncommand-args-options
      //   https://nodejs.org/api/child_process.html#default-windows-shell
      //   https://github.com/npm/run-script/blob/a5b03bdfc3a499bf7587d7414d5ea712888bfe93/lib/make-spawn-args.js#L11
      shell: true,
    });

    child.stdout.on('data', (data: string | Buffer) => {
      this._logger.log({
        script,
        type: 'output',
        stream: 'stdout',
        data,
      });
    });

    child.stderr.on('data', (data: string | Buffer) => {
      this._logger.log({
        script,
        type: 'output',
        stream: 'stderr',
        data,
      });
    });

    const completed = new Promise<void>((resolve, reject) => {
      child.on('error', (error) => {
        reject(
          new WireitError({
            script,
            type: 'failure',
            reason: 'spawn-error',
            message: error.message,
          })
        );
      });

      child.on('close', (status, signal) => {
        if (signal !== null) {
          reject(
            new WireitError({
              script,
              type: 'failure',
              reason: 'signal',
              signal,
            })
          );
        } else if (status !== 0) {
          reject(
            new WireitError({
              script,
              type: 'failure',
              reason: 'exit-non-zero',
              // status should only ever be null if signal was not null, but
              // this isn't reflected in the TypeScript types. Just in case, and
              // to make TypeScript happy, fall back to -1 (which is a
              // conventional exit status used for "exited with signal").
              status: status ?? -1,
            })
          );
        } else {
          resolve();
        }
      });
    });

    await completed;
  }
}
