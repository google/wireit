/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createReadStream} from 'fs';
import {resolve} from 'path';
import {createHash} from 'crypto';
import {glob} from '../util/glob.js';
import {shuffle} from '../util/shuffle.js';
import {getScriptDataDir} from '../util/script-data-dir.js';

import type {Result} from '../error.js';
import type {Executor} from '../executor.js';
import {
  Fingerprint,
  ScriptConfig,
  ScriptReference,
  ScriptReferenceString,
  scriptReferenceToString,
  Sha256HexDigest,
} from '../script.js';
import type {Logger} from '../logging/logger.js';
import type {Failure, StartCancelled} from '../event.js';

export type ExecutionResult = Result<Fingerprint, Failure[]>;

/**
 * What to do when a script failure occurs:
 *
 * - `no-new`: Allow running scripts to finish, but don't start new ones.
 * - `continue`: Allow running scripts to finish, and start new ones unless a
 *   dependency failed.
 * - `kill`: Immediately kill running scripts, and don't start new ones.
 */
export type FailureMode = 'no-new' | 'continue' | 'kill';

/**
 * A single execution of a specific script.
 */
export abstract class BaseExecution<T extends ScriptConfig> {
  protected readonly script: T;
  protected readonly executor: Executor;
  protected readonly logger: Logger;

  protected constructor(script: T, executor: Executor, logger: Logger) {
    this.script = script;
    this.executor = executor;
    this.logger = logger;
  }

  /**
   * Whether we should return early instead of starting this script.
   *
   * We should check this as the first thing we do, and then after any
   * significant amount of time might have elapsed.
   */
  protected get shouldNotStart(): boolean {
    return this.executor.shouldStopStartingNewScripts;
  }

  /**
   * Convenience to generate a cancellation failure event for this script.
   */
  protected get startCancelledEvent(): StartCancelled {
    return {
      script: this.script,
      type: 'failure',
      reason: 'start-cancelled',
    };
  }

  /**
   * Get the directory name where Wireit data can be saved for this script.
   */
  protected get dataDir(): string {
    return getScriptDataDir(this.script);
  }

  /**
   * Execute all of this script's dependencies.
   */
  protected async executeDependencies(): Promise<
    Result<Array<[ScriptReference, Fingerprint]>, Failure[]>
  > {
    // Randomize the order we execute dependencies to make it less likely for a
    // user to inadvertently depend on any specific order, which could indicate
    // a missing edge in the dependency graph.
    shuffle(this.script.dependencies);
    // Note we use Promise.allSettled instead of Promise.all so that we can
    // collect all errors, instead of just the first one.
    const dependencyResults = await Promise.allSettled(
      this.script.dependencies.map((dependency) => {
        return this.executor.execute(dependency.config);
      })
    );
    const errors = new Set<Failure>();
    const results: Array<[ScriptReference, Fingerprint]> = [];
    for (let i = 0; i < dependencyResults.length; i++) {
      const result = dependencyResults[i];
      if (result.status === 'rejected') {
        const error: unknown = result.reason;
        errors.add({
          type: 'failure',
          reason: 'unknown-error-thrown',
          script: this.script.dependencies[i].config,
          error: error,
        });
      } else {
        if (!result.value.ok) {
          for (const error of result.value.error) {
            errors.add(error);
          }
        } else {
          results.push([
            this.script.dependencies[i].config,
            result.value.value,
          ]);
        }
      }
    }
    if (errors.size > 0) {
      return {ok: false, error: [...errors]};
    }
    return {ok: true, value: results};
  }

  /**
   * Generate the fingerprint data object for this script based on its current
   * configuration, input files, and the fingerprints of its dependencies.
   */
  protected async computeFingerprint(
    dependencyFingerprints: Array<[ScriptReference, Fingerprint]>
  ): Promise<Fingerprint> {
    let allDependenciesAreCacheable = true;
    const filteredDependencyStates: Array<
      [ScriptReferenceString, Fingerprint]
    > = [];
    for (const [dep, depState] of dependencyFingerprints) {
      if (!depState.cacheable) {
        allDependenciesAreCacheable = false;
      }
      filteredDependencyStates.push([scriptReferenceToString(dep), depState]);
    }

    let fileHashes: Array<[string, Sha256HexDigest]>;
    if (this.script.files?.values.length) {
      const files = await glob(this.script.files.values, {
        cwd: this.script.packageDir,
        absolute: false,
        followSymlinks: true,
        // TODO(aomarks) This means that empty directories are not reflected in
        // the fingerprint, however an empty directory could modify the behavior
        // of a script. We should probably include empty directories; we'll just
        // need special handling when we compute the fingerprint, because there
        // is no hash we can compute.
        includeDirectories: false,
        // We must expand directories here, because we need the complete
        // explicit list of files to hash.
        expandDirectories: true,
        throwIfOutsideCwd: false,
      });
      // TODO(aomarks) Instead of reading and hashing every input file on every
      // build, use inode/mtime/ctime/size metadata (which is much faster to
      // read) as a heuristic to detect files that have likely changed, and
      // otherwise re-use cached hashes that we store in e.g.
      // ".wireit/<script>/hashes".
      fileHashes = await Promise.all(
        files.map(async (file): Promise<[string, Sha256HexDigest]> => {
          const absolutePath = resolve(this.script.packageDir, file.path);
          const hash = createHash('sha256');
          for await (const chunk of createReadStream(absolutePath)) {
            hash.update(chunk as Buffer);
          }
          return [file.path, hash.digest('hex') as Sha256HexDigest];
        })
      );
    } else {
      fileHashes = [];
    }

    const cacheable =
      // If command is undefined, then it's always safe to be cached, because
      // the script isn't going to do anything anyway. In these cases, the
      // fingerprint is essentially just the fingerprint of the dependencies.
      this.script.command === undefined ||
      // Otherwise, If files are undefined, then it's not safe to be cached,
      // because we don't know what the inputs are, so we can't know if the
      // output of this script could change.
      (this.script.files !== undefined &&
        // Similarly, if any of our dependencies are uncacheable, then we're
        // uncacheable too, because that dependency could also have an effect on
        // our output.
        allDependenciesAreCacheable);

    return {
      cacheable,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      command: this.script.command?.value,
      clean: this.script.clean,
      files: Object.fromEntries(
        fileHashes.sort(([aFile], [bFile]) => aFile.localeCompare(bFile))
      ),
      output: this.script.output?.values ?? [],
      dependencies: Object.fromEntries(
        filteredDependencyStates.sort(([aRef], [bRef]) =>
          aRef.localeCompare(bRef)
        )
      ),
    };
  }
}
