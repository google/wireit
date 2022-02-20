import * as pathlib from 'path';
import * as fs from 'fs/promises';
import fastglob from 'fast-glob';
import {createHash} from 'crypto';
import {spawn} from 'child_process';

import {KnownError} from '../shared/known-error.js';
import {resolveDependency} from '../shared/resolve-script.js';
import {loggableName} from '../shared/loggable-name.js';
import {iterateParentDirs} from '../shared/iterate-parent-dirs.js';
import {hashReachablePackageLocks} from '../shared/hash-reachable-package-locks.js';

import type {ScriptRunner} from '../shared/script-runner.js';
import type {CachedOutput} from '../shared/cache.js';
import type {RawScript, ResolvedScriptReference} from '../types/config.js';
import type {ScriptStatus, CacheKey} from '../types/cache.js';

/**
 * A single, specific run of a scriprt.
 */
export class ScriptRun {
  private readonly _ctx: ScriptRunner;
  private readonly _ref: ResolvedScriptReference;
  private readonly _scriptName: string;
  private readonly _packageJsonPath: string;
  private readonly _packageDir: string;
  private readonly _logName: string;
  private _configPromise?: Promise<RawScript>;
  private _resolvePromise?: Promise<ScriptStatus>;

  private get _config(): Promise<RawScript> {
    if (this._configPromise === undefined) {
      this._configPromise = this._readConfig();
    }
    return this._configPromise;
  }

  constructor(ctx: ScriptRunner, ref: ResolvedScriptReference) {
    this._ctx = ctx;
    this._ref = ref;
    this._scriptName = ref.scriptName;
    this._packageJsonPath = ref.packageJsonPath;
    this._packageDir = pathlib.dirname(ref.packageJsonPath);
    this._logName = loggableName(ref.packageJsonPath, ref.scriptName);
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
  async resolve(): Promise<ScriptStatus> {
    if (this._resolvePromise === undefined) {
      this._resolvePromise = this._resolve();
    }
    return this._resolvePromise;
  }

  /**
   * The actual implementation of resolve().
   *
   * This private method is separate from the public one because we handle
   * memoization in the public method.
   */
  private async _resolve(): Promise<ScriptStatus> {
    const config = await this._config;

    // Start hashing package locks in the background.
    const packageLockHashesPromise =
      config.checkPackageLocks ?? true
        ? hashReachablePackageLocks(this._packageDir)
        : Promise.resolve([]);

    // Only check for freshness if input files are defined. This requires the
    // user to explicitly tell us when there are no input files to enable
    // skipping scripts that are already fresh. If it's undefined, the user
    // might not have gotten around to specifying the input files yet, so it's
    // safer to assume that the inputs could be anything, and hence always might
    // have changed.
    const canBeFresh = config.files !== undefined;

    // Start reading the old cache key in the background, if we'll need it.
    const oldCacheKeyStrPromise = canBeFresh
      ? this._readOldCacheKeyStr()
      : undefined;

    // IMPORTANT: We must wait until all dependencies have completed before we
    // hash input files, because a dependency could be generating our input
    // files.
    const dependencyCacheKeys = await this._resolveDependencies();

    const newCacheKeyObj = await this._createCacheKey(
      await this._hashInputFiles(),
      dependencyCacheKeys,
      await packageLockHashesPromise
    );
    const newCacheKeyStr = JSON.stringify(newCacheKeyObj);

    if (canBeFresh) {
      const oldCacheKeyStr = await oldCacheKeyStrPromise;
      const isFresh = newCacheKeyStr === oldCacheKeyStr;
      if (isFresh) {
        // TODO(aomarks) Emit a status code instead of logging directly, and
        // then implement a separate logger that understands success statuses
        // and errors.
        this._ctx.emitEvent({
          script: this._ref,
          type: 'success',
          reason: 'fresh',
        });
        return {cacheKey: newCacheKeyObj};
      }
    }

    if (!config.command) {
      this._ctx.emitEvent({
        script: this._ref,
        type: 'success',
        reason: 'no-command',
      });
      return {cacheKey: newCacheKeyObj};
    }

    // Only cache if output files are defined. This requires the user to
    // explicitly tell us when there are no output files to enable caching. If
    // it's undefined, the user might not have gotten around to specifying the
    // output yet, so it's safer to assume that the output could be anything,
    // and we wouldn't otherwise capture them correctly.
    let cacheHitPromise: undefined | Promise<CachedOutput | undefined>;
    if (config.output !== undefined && this._ctx.cache !== undefined) {
      cacheHitPromise = this._ctx.cache.getOutput(
        this._packageJsonPath,
        this._scriptName,
        newCacheKeyStr,
        config.incrementalBuildFiles !== undefined
          ? // TODO(aomarks) Explain why we include incremental build files here.
            // TODO(aomarks) The file globs should not be grouped together, because
            // "!" exclusions shouldn't apply across the two groups.
            [...config.output, ...config.incrementalBuildFiles]
          : config.output
      );
    }

    // Delete the current state before we start running, because if there was a
    // previously successful run in a different state, and this run fails, then
    // the next time we run, we would otherwise incorrectly think that the
    // script was still fresh with the previous state
    await this._deleteFreshnessFile();

    // Delete all existing output files.
    await this._maybeDeleteFiles(cacheHitPromise);

    const cacheHit = await cacheHitPromise;
    if (cacheHit !== undefined) {
      await cacheHit.apply();
      this._ctx.emitEvent({
        script: this._ref,
        type: 'success',
        reason: 'cache-hit',
      });
      return {cacheKey: newCacheKeyObj};
    }

    let pending = true;
    setTimeout(() => {
      // TODO(aomarks) This might fire after we're already done, that's not
      // right.
      //
      // If there is no contention, the promise returned by reserve() will
      // resolve in the next microtask. So if we are still waiting after a
      // macrotask, then there is contention.
      if (pending) {
        this._ctx.emitEvent({
          script: this._ref,
          type: 'parallel-contention',
        });
      }
    });
    const releaseParallelismReservation =
      await this._ctx.parallelismLimiter.reserve();
    pending = false;

    let elapsedMs: number;
    try {
      const startMs = (globalThis as any).performance.now();
      await this._executeCommand();
      elapsedMs = (globalThis as any).performance.now() - startMs;
    } finally {
      releaseParallelismReservation();
    }

    // TODO(aomarks) We don't actually need to wait for the next two writes to
    // finish before allowing dependent scripts to start.
    if (canBeFresh) {
      await this._writeFreshnessFile(newCacheKeyStr);
    }

    if (config.output !== undefined && this._ctx.cache !== undefined) {
      await this._ctx.cache.saveOutput(
        this._packageJsonPath,
        this._scriptName,
        newCacheKeyStr,
        [...config.output, ...(config.incrementalBuildFiles ?? [])]
      );
    }

    this._ctx.emitEvent({
      script: this._ref,
      type: 'success',
      reason: 'exit-zero',
      elapsedMs,
    });
    return {cacheKey: newCacheKeyObj};
  }

  private async _maybeDeleteFiles(
    cacheHitPromise: Promise<CachedOutput | undefined> | undefined
  ) {
    // TODO(aomarks) Explain incremental build file handling.
    const config = await this._config;
    // TODO(aomarks) Set defaults when reading config instead.
    const deleteOutputBeforeEachRun = config.deleteOutputBeforeEachRun ?? true;
    if (!deleteOutputBeforeEachRun) {
      return [];
    }
    const incremental = await this._globs(config.incrementalBuildFiles ?? []);
    if (incremental.length > 0) {
      const cacheHit = await cacheHitPromise;
      if (cacheHit === undefined) {
        return [];
      }
    }
    const output = config.output ?? [];
    let numDeleted = 0;
    if (output.length > 0) {
      const files = await this._globs(output);
      if (files.length > 0) {
        await this._deleteFiles(files);
        numDeleted += files.length;
      }
    }
    if (incremental.length > 0) {
      const files = await this._globs(incremental);
      if (files.length > 0) {
        await this._deleteFiles(files);
        numDeleted += files.length;
      }
    }
    this._ctx.emitEvent({
      script: this._ref,
      type: 'output-deleted',
      numDeleted,
    });
  }

  private async _globs(globs: string[]): Promise<string[]> {
    return await fastglob(globs, {
      cwd: this._packageDir,
      dot: true,
      followSymbolicLinks: false,
    });
  }

  private async _deleteFiles(files: string[]): Promise<void> {
    await Promise.all(
      files.map((file) => fs.rm(file, {recursive: true, force: true}))
    );
  }

  private async _readConfig(): Promise<RawScript> {
    const rawConfig = await this._ctx.getRawPackageConfig(
      this._packageJsonPath
    );
    const script = rawConfig.scripts?.[this._scriptName];
    if (script === undefined) {
      throw new KnownError(
        'script-not-found',
        `[${this._logName}] Could not find script ${this._scriptName} in ${this._packageJsonPath}`
      );
    }
    return script;
  }

  /**
   * Canonicalize all of this script's declared dependencies.
   *
   * Note that each declared dependency can resolve to 0, 1, or >1 canonical
   * dependencies. For example, "$WORKSPACES:build" could return 0 dependencies
   * if there are no workspaces, or >1 if there is more than one workspace.
   */
  private async *_canonicalizeDependencies(): AsyncIterable<ResolvedScriptReference> {
    const config = await this._config;
    if (config.dependencies === undefined || config.dependencies.length === 0) {
      return;
    }
    const promises: Array<
      Promise<{idx: number; references: ResolvedScriptReference[]}> | undefined
    > = config.dependencies.map(async (specifier, idx) => {
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
    while (true) {
      // TODO(aomarks) This is dumb.
      const filtered = promises.filter((promise) => promise !== undefined);
      if (filtered.length === 0) {
        break;
      }
      const x = await Promise.race(filtered);
      if (x !== undefined) {
        const {references, idx} = x;
        yield* references;
        promises[idx] = undefined;
      }
    }
  }

  private async _resolveDependencies(): Promise<Array<[string, CacheKey]>> {
    const promises = [];
    const errors: unknown[] = [];
    const cacheKeys: Array<[string, CacheKey]> = [];
    for await (const dep of this._canonicalizeDependencies()) {
      promises.push(
        (async () => {
          try {
            const status = await this._ctx.run(dep);
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
        })()
      );
    }
    await Promise.all(promises);
    if (errors.length > 0) {
      throw new AggregateError(errors);
    }
    return cacheKeys;
  }

  private async _readOldCacheKeyStr(): Promise<string | undefined> {
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
    const config = await this._config;
    const result: Array<[string, {sha256: string}]> = [];
    if (config.files === undefined || config.files.length === 0) {
      return result;
    }
    const files = await fastglob(config.files, {
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

  private async _createCacheKey(
    inputFileHashes: Array<[string, {sha256: string}]>,
    dependencyCacheKeys: Array<[string, CacheKey]>,
    npmPackageLocks: Array<[string, {sha256: string}]>
  ): Promise<CacheKey> {
    const config = await this._config;
    // IMPORTANT: We must sort everything here, because this cache key must be
    // deterministic, and insertion order affects the JSON serialization.
    const data: CacheKey = {
      command: config.command ?? '',
      files: Object.fromEntries(
        inputFileHashes.sort((a, b) => a[0].localeCompare(b[0]))
      ),
      dependencies: Object.fromEntries(
        dependencyCacheKeys.sort((a, b) => a[0].localeCompare(b[0]))
      ),
      npmPackageLocks: Object.fromEntries(
        npmPackageLocks.sort((a, b) => a[0].localeCompare(b[0]))
      ),
      // Note globs are not sorted because "!" exclusion globs affect preceding
      // globs, but not subsequent ones.
      //
      // TODO(aomarks) In theory we could be smarter here, and do a sort which
      // is careful to only sort within each "!"-delimited block. This could
      // yield more cache hits when only trivial re-oredering is done to glob
      // lists.
      outputGlobs: config.output ?? [],
      incrementalBuildFiles: config.incrementalBuildFiles ?? [],
    };
    return data;
  }

  private async _executeCommand(): Promise<void> {
    const config = await this._config;
    if (!config.command) {
      return;
    }
    this._ctx.emitEvent({
      script: this._ref,
      type: 'spawn',
      command: config.command,
    });
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

    const child = spawn('sh', ['-c', config.command], {
      cwd: this._packageDir,
      detached: true,
      env: {
        ...process.env,
        PATH: childPathEnv,
      },
    });
    let aborted = false;
    const completed = new Promise<void>((resolve, reject) => {
      // TODO(aomarks) Do we need to handle "close"? Is there any way a
      // "close" event can be fired, but not an "exit" or "error" event?
      child.on('error', (error) => {
        this._ctx.emitEvent({
          script: this._ref,
          type: 'failure',
          reason: 'start-error',
          message: error.message,
        });
        reject(
          new KnownError(
            'script-control-error',
            `Command ${this._scriptName} failed to start`
          )
        );
      });
      child.on('exit', (code, signal) => {
        if (signal !== null) {
          this._ctx.emitEvent({
            script: this._ref,
            type: 'failure',
            reason: 'interrupt',
            signal,
            intentional: aborted,
          });
          reject(
            new KnownError(
              aborted
                ? 'script-cancelled-intentionally'
                : 'script-cancelled-unexpectedly',
              `Command ${this._scriptName} exited with signal ${signal}`
            )
          );
        } else if (code !== 0) {
          this._ctx.emitEvent({
            script: this._ref,
            type: 'failure',
            reason: 'exit-non-zero',
            code: code ?? -1,
          });
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
    child.stdout.on('data', (data: string | Buffer) => {
      this._ctx.emitEvent({
        script: this._ref,
        type: 'output',
        stream: 'stdout',
        data,
      });
    });
    // TODO(aomarks) Ensure the streams close.
    child.stderr.on('data', (data: string | Buffer) => {
      this._ctx.emitEvent({
        script: this._ref,
        type: 'output',
        stream: 'stderr',
        data,
      });
    });
    await Promise.race([
      completed,
      this._ctx.abort.then(() => (aborted = true)),
    ]);
    if (aborted) {
      const signal = 'SIGINT';
      this._ctx.emitEvent({script: this._ref, type: 'killing', signal});
      process.kill(-child.pid!, signal);
      await completed;
      throw new Error(
        `[${this._logName}] Unexpected internal error. ` +
          `Script ${this._scriptName} should have thrown.`
      );
    }
  }

  private async _deleteFreshnessFile(): Promise<void> {
    await fs.rm(this._freshnessFilePath, {force: true});
  }

  private async _writeFreshnessFile(currentStateStr: string): Promise<void> {
    await fs.mkdir(pathlib.dirname(this._freshnessFilePath), {
      recursive: true,
    });
    await fs.writeFile(this._freshnessFilePath, currentStateStr, 'utf8');
  }

  private get _freshnessFilePath(): string {
    return pathlib.resolve(
      this._packageDir,
      '.wireit',
      'state',
      this._scriptName
    );
  }
}
