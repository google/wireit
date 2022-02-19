import * as pathlib from 'path';
import * as fs from 'fs/promises';
import fastglob from 'fast-glob';
import {createHash} from 'crypto';
import {spawn} from 'child_process';

import {KnownError} from '../shared/known-error.js';
import {resolveDependency} from '../shared/resolve-script.js';
import {loggableName} from '../shared/loggable-name.js';
import {iterateParentDirs} from '../shared/iterate-parent-dirs.js';

import type {RawScript, ResolvedScriptReference} from '../types/config.js';

/**
 * A single, specific run of a scriprt.
 */
export class ScriptRun {
  private readonly _config: RawScript;
  private readonly _scriptName: string;
  private readonly _packageJsonPath: string;
  private readonly _packageDir: string;
  private readonly _logName: string;
  private _resolvePromise?: Promise<void>;
  private _killingIntentionally = false;

  constructor(id: ResolvedScriptReference, config: RawScript) {
    this._scriptName = id.scriptName;
    this._packageJsonPath = id.packageJsonPath;
    this._packageDir = pathlib.dirname(id.packageJsonPath);
    this._logName = loggableName(id.packageJsonPath, id.scriptName);
    this._config = config;
  }

  /**
   * Ensure this script's output is in the expected state.
   *
   * - If it is already fresh, do nothing.
   * - Otherwise, if it has a cache hit, restore the cached output.
   * - Otherwise, execute the script.
   *
   * Note if this method is invoked multiple times, it will always return the
   * same promise. One instance of a ScriptRun will never execute the same
   * command more than once.
   */
  async resolve(): Promise<void> {
    if (this._resolvePromise === undefined) {
      this._resolvePromise = this._resolve();
    }
    return this._resolvePromise;
  }

  /**
   * The internal implementation of resolve().
   *
   * This private method is separate from the public one because we handle
   * memoization in the public method.
   */
  async _resolve(): Promise<void> {
    // Start resolving dependencies in the background.
    const dependenciesResolvedPromise = this._resolveDependencies();

    // Only check for freshness if input files are defined. This requires the
    // user to explicitly tell us when there are no input files to enable
    // skipping scripts that are already fresh. If it's undefined, the user
    // might not have gotten around to specifying the input files yet, so it's
    // safer to assume that the inputs could be anything, and hence always might
    // have changed.
    if (this._config.files !== undefined) {
      // Start reading the old cache key in the background.
      const oldCacheKeyPromise = this._readOldCacheKey();
      const dependencyCacheKeys = await dependenciesResolvedPromise;
      // Wait until all dependencies have completed before we hash input files,
      // because a dependency could be generating our input files.
      const inputFileHashes = await this._hashInputFiles();
      const newCacheKey = this._createCacheKey(
        inputFileHashes,
        dependencyCacheKeys
      );
      const oldCacheKey = await oldCacheKeyPromise;
      const isFresh = newCacheKey === oldCacheKey;
      if (isFresh) {
        // TODO(aomarks) Emit a status code instead of logging directly, and
        // then implement a separate logger that understands success statuses
        // and errors.
        console.log(`🥬 [${this._logName}] Already fresh!`);
        return;
      }
    }

    await dependenciesResolvedPromise;

    if (!this._config.command) {
      console.log(`✅ [${this._logName}] Succeeded (no command)`);
      return;
    }

    const startMs = (globalThis as any).performance.now();
    await this._executeCommand();
    const elapsedMs = (globalThis as any).performance.now() - startMs;
    console.log(
      `✅ [${this._logName}] Succeeded in ${Math.round(elapsedMs)}ms`
    );
  }

  /**
   * Canonicalize all of this script's declared dependencies.
   *
   * Note that each declared dependency can resolve to 0, 1, or >1 canonical
   * dependencies. For example, "$WORKSPACES:build" could return 0 dependencies
   * if there are no workspaces, or >1 if there is more than one workspace.
   */
  async *_canonicalizeDependencies(): AsyncIterable<ResolvedScriptReference> {
    if (
      this._config.dependencies === undefined ||
      this._config.dependencies.length === 0
    ) {
      return;
    }
    const promises = this._config.dependencies.map(async (specifier, idx) => {
      const references = await resolveDependency(
        this._packageJsonPath,
        specifier,
        this._scriptName
      );
      // We need to return the index as well as the result so that we are able
      // to splice the corresponding promise out of the promise array.
      return {references, idx};
    });
    // Yield dependencies as soon as they are canonicalized. Canonicalizing
    // dependencies take a variable amount of time, because some are already
    // canonicalized, while others require reading package.json files from other
    // packages.
    while (promises.length > 0) {
      const {references, idx} = await Promise.race(promises);
      promises.splice(idx, 1);
      yield* references;
    }
  }

  async _resolveDependencies(): Promise<Array<[string, CacheKey]>> {
    const promises = [];
    const errors: unknown[] = [];
    const cacheKeys: Array<[string, CacheKey]> = [];
    for await (const dep of this._canonicalizeDependencies()) {
      promises.push(async () => {
        try {
          const status = await this._resolveDependency(dep);
          const cacheName =
            dep.packageJsonPath === this._packageJsonPath
              ? dep.scriptName
              : `${pathlib.relative(
                  this._packageDir,
                  pathlib.dirname(dep.packageJsonPath)
                )}:${dep.scriptName}`;
          cacheKeys.push([cacheName, status.cacheKey]);
        } catch (error) {
          if (error instanceof AggregateError) {
            errors.push(...error.errors);
          } else {
            errors.push(error);
          }
        }
      });
    }
    await Promise.all(promises);
    if (errors.length > 0) {
      throw new AggregateError(errors);
    }
    return cacheKeys;
  }

  async _resolveDependency(
    dep: ResolvedScriptReference
  ): Promise<ScriptStatus> {
    // TODO(aomarks)
    console.log(dep);
    throw new Error('NOT IMPLEMENTED');
  }

  private async _readOldCacheKey(): Promise<string | undefined> {
    const stateFile = pathlib.resolve(
      this._packageDir,
      '.wireit',
      'state',
      this._scriptName
    );
    try {
      return await fs.readFile(stateFile, 'utf8');
    } catch (err) {
      if ((err as {code?: string}).code === 'ENOENT') {
        return undefined;
      }
      throw err;
    }
  }

  private async _hashInputFiles(): Promise<Array<[string, {sha256: string}]>> {
    const result: Array<[string, {sha256: string}]> = [];
    if (this._config.files === undefined || this._config.files.length === 0) {
      return result;
    }
    const files = await fastglob(this._config.files, {
      cwd: this._packageDir,
      dot: true,
      followSymbolicLinks: false,
    });
    const hashedPromises = [];
    for (const file of files) {
      hashedPromises.push(
        (async () => {
          const content = await fs.readFile(
            pathlib.resolve(this._packageDir, file),
            'utf8'
          );
          const sha256 = createHash('sha256').update(content).digest('hex');
          result.push([file, {sha256}]);
        })()
      );
    }
    await Promise.all(hashedPromises);
    return result;
  }

  private _createCacheKey(
    inputFileHashes: Array<[string, {sha256: string}]>,
    dependencyCacheKeys: Array<[string, CacheKey]>
  ): string {
    // IMPORTANT: We must sort everything here, because this cache key must be
    // deterministic, and insertion order affects the JSON serialization.
    const data: CacheKey = {
      command: this._config.command ?? '',
      files: Object.fromEntries(
        inputFileHashes.sort((a, b) => a[0].localeCompare(b[0]))
      ),
      dependencies: Object.fromEntries(
        dependencyCacheKeys.sort((a, b) => a[0].localeCompare(b[0]))
      ),
      // TODO(aomarks) npmPackageLocks
      npmPackageLocks: {},
      // Note globs are not sorted because "!" exclusion globs affect preceding
      // globs, but not subsequent ones.
      //
      // TODO(aomarks) In theory we could be smarter here, and do a sort which
      // is careful to only sort within each "!"-delimited block. This could
      // yield more cache hits when only trivial re-oredering is done to glob
      // lists.
      outputGlobs: this._config.output ?? [],
      incrementalBuildFiles: this._config.incrementalBuildFiles ?? [],
    };
    return JSON.stringify(data);
  }

  private async _executeCommand(): Promise<void> {
    if (!this._config.command) {
      return;
    }
    // We could spawn a "npx -c" or "npm exec -c" command to set up the PATH
    // automatically, but we instead invoke the shell command directly. This is
    // because:
    //
    // 1. There is an issue related recursive invocations of those commands.
    //    Specifically, using either sets an "npm_config_call" environment
    //    variable, which then takes precedence over any argv command passed to
    //    an "npx" (but not "npm exec") command that could be invoked
    //    recursively. This prevents the use of "npx" within scripts.
    //    TODO(aomarks) File a bug on npx about this.
    //
    // 2. It's much faster to invoke the shell command directly, since that
    //    bypasses an intermediate npm Node process.
    const childPathEnv =
      [...iterateParentDirs(this._packageDir)]
        .map((dir) => pathlib.join(dir, 'node_modules', '.bin'))
        .join(':') +
      ':' +
      process.env.PATH;

    const child = spawn('sh', ['-c', this._config.command], {
      cwd: this._packageDir,
      stdio: 'inherit',
      detached: true,
      env: {
        ...process.env,
        PATH: childPathEnv,
      },
    });
    const completed = new Promise<void>((resolve, reject) => {
      // TODO(aomarks) Do we need to handle "close"? Is there any way a
      // "close" event can be fired, but not an "exit" or "error" event?
      child.on('error', () => {
        reject(
          new KnownError(
            'script-control-error',
            `Command ${this._scriptName} failed to start`
          )
        );
      });
      child.on('exit', (code, signal) => {
        if (signal !== null) {
          reject(
            new KnownError(
              this._killingIntentionally
                ? 'script-cancelled-intentionally'
                : 'script-cancelled-unexpectedly',
              `Command ${this._scriptName} exited with signal ${signal}`
            )
          );
        } else if (code !== 0) {
          reject(
            new KnownError(
              'script-failed',
              `[${this._logName}] Command failed with code ${code}`
            )
          );
        } else {
          resolve();
        }
      });
    });
    await completed;
  }
}

interface CacheKey {
  command: string;
  // Must be sorted by filename.
  files: {[fileName: string]: FileContentHash};
  // Must be sorted by script name.
  dependencies: {[scriptName: string]: CacheKey};
  // Must be sorted by script name.
  npmPackageLocks: {[fileName: string]: FileContentHash};
  // Must preserve the specified order, because the meaning of `!` depends on
  // which globs preceded it.
  outputGlobs: string[];
  // Must preserve the specified order, because the meaning of `!` depends on
  // which globs preceded it.
  incrementalBuildFiles: string[];
}

// TODO(aomarks) What about permission bits?
interface FileContentHash {
  sha256: string;
}

interface ScriptStatus {
  cacheKey: CacheKey;
}
