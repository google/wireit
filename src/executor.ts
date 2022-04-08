/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fastGlob from 'fast-glob';
import * as pathlib from 'path';
import * as fs from 'fs/promises';
import {createHash} from 'crypto';
import {createReadStream, createWriteStream} from 'fs';
import {spawn} from 'child_process';
import {WireitError} from './error.js';
import {scriptReferenceToString} from './script.js';
import {shuffle} from './util/shuffle.js';
import {WorkerPool} from './util/worker-pool.js';
import {getScriptDataDir} from './util/script-data-dir.js';

import type {
  ScriptConfig,
  ScriptReference,
  ScriptReferenceString,
  ScriptState,
  ScriptStateString,
  Sha256HexDigest,
} from './script.js';
import type {Logger} from './logging/logger.js';
import type {WriteStream} from 'fs';
import type {Cache} from './caching/cache.js';

/**
 * Unique symbol to represent a script that isn't safe to be cached, because its
 * input files, or the input files of one of its transitive dependencies, are
 * undefined.
 */
const UNCACHEABLE = Symbol();

/**
 * The PATH environment variable of this process, minus all of the leading
 * "node_modules/.bin" entries that the incoming "npm run" command already set.
 *
 * We want full control over which "node_modules/.bin" paths are in the PATH of
 * the processes we spawn, so that cross-package dependencies act as though we
 * are running "npm run" with each package as the cwd.
 *
 * We only need to do this once per Wireit process, because process.env never
 * changes.
 */
const PATH_ENV_SUFFIX = (() => {
  const path = process.env.PATH ?? '';
  // Note the PATH delimiter is platform-dependent.
  const entries = path.split(pathlib.delimiter);
  const nodeModulesBinSuffix = pathlib.join('node_modules', '.bin');
  const endOfNodeModuleBins = entries.findIndex(
    (entry) => !entry.endsWith(nodeModulesBinSuffix)
  );
  return entries.slice(endOfNodeModuleBins).join(pathlib.delimiter);
})();

const IS_WINDOWS = process.platform === 'win32';

/**
 * Executes a script that has been analyzed and validated by the Analyzer.
 */
export class Executor {
  readonly #executions = new Map<
    string,
    Promise<ScriptState | typeof UNCACHEABLE>
  >();
  readonly #logger: Logger;
  readonly #workerPool: WorkerPool;
  readonly #cache?: Cache;

  constructor(
    logger: Logger,
    workerPool: WorkerPool,
    cache: Cache | undefined
  ) {
    this.#logger = logger;
    this.#workerPool = workerPool;
    this.#cache = cache;
  }

  async execute(
    script: ScriptConfig
  ): Promise<ScriptState | typeof UNCACHEABLE> {
    const executionKey = scriptReferenceToString(script);
    let promise = this.#executions.get(executionKey);
    if (promise === undefined) {
      promise = ScriptExecution.execute(
        script,
        this,
        this.#workerPool,
        this.#cache,
        this.#logger
      );
      this.#executions.set(executionKey, promise);
    }
    return promise;
  }
}

/**
 * A single execution of a specific script.
 */
class ScriptExecution {
  static execute(
    script: ScriptConfig,
    executor: Executor,
    workerPool: WorkerPool,
    cache: Cache | undefined,
    logger: Logger
  ): Promise<ScriptState | typeof UNCACHEABLE> {
    return new ScriptExecution(
      script,
      executor,
      workerPool,
      cache,
      logger
    ).#execute();
  }

  readonly #script: ScriptConfig;
  readonly #executor: Executor;
  readonly #cache?: Cache;
  readonly #workerPool: WorkerPool;
  readonly #logger: Logger;

  private constructor(
    script: ScriptConfig,
    executor: Executor,
    workerPool: WorkerPool,
    cache: Cache | undefined,
    logger: Logger
  ) {
    this.#script = script;
    this.#executor = executor;
    this.#workerPool = workerPool;
    this.#cache = cache;
    this.#logger = logger;
  }

  async #execute(): Promise<ScriptState | typeof UNCACHEABLE> {
    const dependencyStates = await this.#executeDependencies();
    // Note we must wait for dependencies to finish before generating the cache
    // key, because a dependency could create or modify an input file to this
    // script, which would affect the key.
    const state = await this.#computeState(dependencyStates);
    let stateStr: ScriptStateString | typeof UNCACHEABLE;
    if (state !== UNCACHEABLE) {
      stateStr = JSON.stringify(state) as ScriptStateString;
      const prevStateStr = await this.#readPreviousState();
      if (prevStateStr !== undefined && stateStr === prevStateStr) {
        // TODO(aomarks) Does not preserve original order of stdout vs stderr
        // chunks. See https://github.com/google/wireit/issues/74.
        await Promise.all([
          this.#replayStdoutIfPresent(),
          this.#replayStderrIfPresent(),
        ]);
        this.#logger.log({
          script: this.#script,
          type: 'success',
          reason: 'fresh',
        });
        return state;
      }
    } else {
      stateStr = UNCACHEABLE;
    }

    // It's important that we delete any previous state before running the
    // command or restoring from cache, because if either fails mid-flight, we
    // don't want to think that the previous state is still valid.
    await this.#prepareDataDir();

    const cacheHit =
      stateStr !== UNCACHEABLE
        ? await this.#cache?.get(this.#script, stateStr)
        : undefined;

    // The "clean" setting controls whether we delete output before execution.
    //
    // However, if we are restoring from cache, we should always delete existing
    // output, regardless of the "clean" setting. The purpose of the "clean"
    // setting is to allow tools that are smart about cleaning up their own
    // previous output to work more efficiently, but that only applies when the
    // tool is able to observe each incremental change to the input files. When
    // we restore from cache, we are directly replacing the output files, and
    // not invoking the tool at all, so there is no way for the tool to do any
    // cleanup.
    if (this.#script.clean || cacheHit !== undefined) {
      await this.#cleanOutput();
    }

    if (cacheHit !== undefined) {
      await cacheHit.apply();
      // We include stdout and stderr replay files when we save to the cache, so
      // if there were any, they will now be in place.
      // TODO(aomarks) Does not preserve original order of stdout vs stderr
      // chunks. See https://github.com/google/wireit/issues/74.
      await Promise.all([
        this.#replayStdoutIfPresent(),
        this.#replayStderrIfPresent(),
      ]);
      this.#logger.log({
        script: this.#script,
        type: 'success',
        reason: 'cached',
      });
    } else {
      await this.#executeCommandIfNeeded();
    }

    if (stateStr !== UNCACHEABLE) {
      // TODO(aomarks) We don't technically need to wait for these to finish to
      // return, we only need to wait in the top-level call to execute. The same
      // will go for saving output to the cache.
      await this.#writeStateFile(stateStr);
      if (cacheHit === undefined) {
        await this.#saveToCacheIfPossible(stateStr);
      }
    }

    return state;
  }

  async #executeDependencies(): Promise<
    Array<[ScriptReference, ScriptState | typeof UNCACHEABLE]>
  > {
    // Randomize the order we execute dependencies to make it less likely for a
    // user to inadvertently depend on any specific order, which could indicate
    // a missing edge in the dependency graph.
    shuffle(this.#script.dependencies);
    // Note we use Promise.allSettled instead of Promise.all so that we can
    // collect all errors, instead of just the first one.
    const dependencyResults = await Promise.allSettled(
      this.#script.dependencies.map((dependency) =>
        this.#executor.execute(dependency)
      )
    );
    const errors: unknown[] = [];
    const results: Array<[ScriptReference, ScriptState | typeof UNCACHEABLE]> =
      [];
    for (let i = 0; i < dependencyResults.length; i++) {
      const result = dependencyResults[i];
      if (result.status === 'rejected') {
        const error: unknown = result.reason;
        if (error instanceof AggregateError) {
          // Flatten nested AggregateErrors.
          errors.push(...(error.errors as unknown[]));
        } else {
          errors.push(error);
        }
      } else {
        results.push([this.#script.dependencies[i], result.value]);
      }
    }
    if (errors.length > 0) {
      throw errors.length === 1 ? errors[0] : new AggregateError(errors);
    }
    return results;
  }

  async #executeCommandIfNeeded(): Promise<void> {
    // It's valid to not have a command defined, since thats a useful way to
    // alias a group of dependency scripts. In this case, we can return early.
    if (!this.#script.command) {
      this.#logger.log({
        script: this.#script,
        type: 'success',
        reason: 'no-command',
      });
      return;
    }

    this.#logger.log({
      script: this.#script,
      type: 'info',
      detail: 'running',
    });

    const command = this.#script.command;
    await this.#workerPool.run(async () => {
      // TODO(aomarks) Update npm_ environment variables to reflect the new
      // package.
      const child = spawn(command, {
        cwd: this.#script.packageDir,
        // Conveniently, "shell:true" has the same shell-selection behavior as
        // "npm run", where on macOS and Linux it is "sh", and on Windows it is
        // %COMSPEC% || "cmd.exe".
        //
        // References:
        //   https://nodejs.org/api/child_process.html#child_processspawncommand-args-options
        //   https://nodejs.org/api/child_process.html#default-windows-shell
        //   https://github.com/npm/run-script/blob/a5b03bdfc3a499bf7587d7414d5ea712888bfe93/lib/make-spawn-args.js#L11
        shell: true,
        env: {
          ...process.env,
          PATH: this.#pathEnvironmentVariable,
        },
      });

      // Only create the stdout/stderr replay files if we encounter anything on
      // this streams.
      let stdoutReplay: WriteStream | undefined;
      let stderrReplay: WriteStream | undefined;

      child.stdout.on('data', (data: string | Buffer) => {
        this.#logger.log({
          script: this.#script,
          type: 'output',
          stream: 'stdout',
          data,
        });
        if (stdoutReplay === undefined) {
          stdoutReplay = createWriteStream(this.#stdoutReplayPath);
        }
        stdoutReplay.write(data);
      });

      child.stderr.on('data', (data: string | Buffer) => {
        this.#logger.log({
          script: this.#script,
          type: 'output',
          stream: 'stderr',
          data,
        });
        if (stderrReplay === undefined) {
          stderrReplay = createWriteStream(this.#stderrReplayPath);
        }
        stderrReplay.write(data);
      });

      const completed = new Promise<void>((resolve, reject) => {
        child.on('error', (error) => {
          reject(
            new WireitError({
              script: this.#script,
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
                script: this.#script,
                type: 'failure',
                reason: 'signal',
                signal,
              })
            );
          } else if (status !== 0) {
            reject(
              new WireitError({
                script: this.#script,
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

      try {
        await completed;
      } finally {
        if (stdoutReplay !== undefined) {
          await closeWriteStream(stdoutReplay);
        }
        if (stderrReplay !== undefined) {
          await closeWriteStream(stderrReplay);
        }
      }
    });

    this.#logger.log({
      script: this.#script,
      type: 'success',
      reason: 'exit-zero',
    });
  }

  /**
   * Generates the PATH environment variable that should be set when this
   * script's command is spawned.
   */
  get #pathEnvironmentVariable(): string {
    // Given package "/foo/bar", walk up the path hierarchy to generate
    // "/foo/bar/node_modules/.bin:/foo/node_modules/.bin:/node_modules/.bin".
    const entries = [];
    let cur = this.#script.packageDir;
    while (true) {
      entries.push(pathlib.join(cur, 'node_modules', '.bin'));
      const parent = pathlib.dirname(cur);
      if (parent === cur) {
        break;
      }
      cur = parent;
    }
    // Add the inherited PATH variable, minus any "node_modules/.bin" entries
    // that were set by the "npm run" command that spawned Wireit.
    entries.push(PATH_ENV_SUFFIX);
    // Note the PATH delimiter is platform-dependent.
    return entries.join(pathlib.delimiter);
  }

  /**
   * Save the current output files to the configured cache if possible.
   */
  async #saveToCacheIfPossible(
    stateStr: ScriptStateString | typeof UNCACHEABLE
  ): Promise<void> {
    if (
      stateStr === UNCACHEABLE ||
      this.#cache === undefined ||
      this.#script.output === undefined
    ) {
      return;
    }
    await this.#cache.set(
      this.#script,
      stateStr,
      await this.#glob(
        [
          ...this.#script.output,
          // Also include the "stdout" and "stderr" replay files at their
          // standard location within the ".wireit" directory for this script so
          // that we can replay them after restoring.
          //
          // We're passing this to #glob because it's an easy way to only
          // include them only if they exist. We don't want to include files
          // that don't exist becuase then we'll make empty directories and will
          // get an error from fs.cp.
          //
          // Convert to relative paths because we want to pass relative paths to
          // Cache.set, but fast-glob doesn't automatically relativize to the
          // cwd when passing an absolute path.
          //
          // Convert Windows-style paths to POSIX-style paths if we are on
          // Windows, because fast-glob only understands POSIX-style paths.
          posixifyPathIfOnWindows(
            pathlib.relative(this.#script.packageDir, this.#stdoutReplayPath)
          ),
          posixifyPathIfOnWindows(
            pathlib.relative(this.#script.packageDir, this.#stderrReplayPath)
          ),
        ],
        {
          onlyFiles: false,
          absolute: false,
        }
      )
    );
  }

  /**
   * Generate the cache key for this script based on its current input files,
   * and the cache keys of its dependencies.
   *
   * Returns the sentinel value {@link UNCACHEABLE} if this script, or any of
   * this script's transitive dependencies, have undefined input files.
   */
  async #computeState(
    dependencyStates: Array<[ScriptReference, ScriptState | typeof UNCACHEABLE]>
  ): Promise<ScriptState | typeof UNCACHEABLE> {
    if (
      this.#script.files === undefined &&
      this.#script.command !== undefined
    ) {
      // If files are undefined, then it's never safe for us to be cached,
      // because we don't know what the inputs are, so we can't know if the
      // output of this script could change.
      //
      // However, if the command is also undefined, then it actually _is_ safe
      // to be cached, because the script isn't itself going to do anything
      // anyway. In that case, the cache keys will be purely the cache keys of
      // the dependencies.
      return UNCACHEABLE;
    }

    const filteredDependencyStates: Array<
      [ScriptReferenceString, ScriptState]
    > = [];
    for (const [dep, depState] of dependencyStates) {
      if (depState === UNCACHEABLE) {
        // If one of our dependencies is uncacheable, then we're uncacheable
        // too, because that dependency could have an effect on our output.
        return UNCACHEABLE;
      }
      filteredDependencyStates.push([scriptReferenceToString(dep), depState]);
    }

    let fileHashes: Array<[string, Sha256HexDigest]>;
    if (this.#script.files?.length) {
      const files = await fastGlob(this.#script.files, {
        cwd: this.#script.packageDir,
        dot: true,
        onlyFiles: true,
        absolute: false,
      });
      // TODO(aomarks) Instead of reading and hashing every input file on every
      // build, use inode/mtime/ctime/size metadata (which is much faster to
      // read) as a heuristic to detect files that have likely changed, and
      // otherwise re-use cached hashes that we store in e.g.
      // ".wireit/<script>/hashes".
      fileHashes = await Promise.all(
        files.map(async (file): Promise<[string, Sha256HexDigest]> => {
          const absolutePath = pathlib.resolve(this.#script.packageDir, file);
          const hash = createHash('sha256');
          for await (const chunk of createReadStream(absolutePath)) {
            hash.update(chunk as Buffer);
          }
          return [file, hash.digest('hex') as Sha256HexDigest];
        })
      );
    } else {
      fileHashes = [];
    }

    return {
      command: this.#script.command,
      clean: this.#script.clean,
      files: Object.fromEntries(
        fileHashes.sort(([aFile], [bFile]) => aFile.localeCompare(bFile))
      ),
      output: this.#script.output ?? [],
      dependencies: Object.fromEntries(
        filteredDependencyStates.sort(([aRef], [bRef]) =>
          aRef.localeCompare(bRef)
        )
      ),
    };
  }

  /**
   * Get the directory name where Wireit data can be saved for this script.
   */
  get #dataDir(): string {
    return getScriptDataDir(this.#script);
  }

  /**
   * Get the path where the current cache key is saved for this script.
   */
  get #statePath(): string {
    return pathlib.join(this.#dataDir, 'state');
  }

  /**
   * Get the path where the stdout replay is saved for this script.
   */
  get #stdoutReplayPath(): string {
    return pathlib.join(this.#dataDir, 'stdout');
  }

  /**
   * Get the path where the stderr replay is saved for this script.
   */
  get #stderrReplayPath(): string {
    return pathlib.join(this.#dataDir, 'stderr');
  }

  /**
   * Read this script's ".wireit/<hex-script-name>/state" file.
   */
  async #readPreviousState(): Promise<ScriptStateString | undefined> {
    try {
      return (await fs.readFile(this.#statePath, 'utf8')) as ScriptStateString;
    } catch (error) {
      if ((error as {code?: string}).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Write this script's ".wireit/<hex-script-name>/state" file.
   */
  async #writeStateFile(stateStr: ScriptStateString): Promise<void> {
    await fs.mkdir(this.#dataDir, {recursive: true});
    await fs.writeFile(this.#statePath, stateStr, 'utf8');
  }

  /**
   * Delete all state for this script from the previous run, and ensure the data
   * directory is created.
   */
  async #prepareDataDir(): Promise<void> {
    await Promise.all([
      fs.rm(this.#statePath, {force: true}),
      fs.rm(this.#stdoutReplayPath, {force: true}),
      fs.rm(this.#stderrReplayPath, {force: true}),
      fs.mkdir(this.#dataDir, {recursive: true}),
    ]);
  }

  /**
   * Delete all files matched by this script's "output" glob patterns.
   */
  async #cleanOutput(): Promise<void> {
    if (this.#script.output === undefined) {
      return;
    }
    const absFiles = await this.#glob(this.#script.output, {
      onlyFiles: false,
      absolute: true,
    });
    if (absFiles.length === 0) {
      return;
    }
    const insidePackagePrefix = this.#script.packageDir + pathlib.sep;
    for (const absFile of absFiles) {
      // TODO(aomarks) It would be better to do this in the Analyzer by looking
      // at the output glob patterns, so that we catch errors earlier and can
      // provide a more useful message, but we need to be certain that we are
      // parsing glob patterns correctly (e.g. negations and other syntax make
      // it slightly tricky to detect).
      if (!absFile.startsWith(insidePackagePrefix)) {
        throw new WireitError({
          script: this.#script,
          type: 'failure',
          reason: 'invalid-config-syntax',
          message: `refusing to delete output file outside of package: ${absFile}`,
        });
      }
    }
    await Promise.all(
      absFiles.map(async (absFile) => {
        try {
          await fs.rm(absFile, {recursive: true});
        } catch (error) {
          if ((error as {code?: string}).code !== 'ENOENT') {
            throw error;
          }
        }
      })
    );
  }

  /**
   * Match the given glob patterns against the filesystem, interpreting paths
   * relative to this script's package directory.
   */
  async #glob(
    patterns: string[],
    {onlyFiles, absolute}: {onlyFiles: boolean; absolute: boolean}
  ): Promise<string[]> {
    const files = await fastGlob(patterns, {
      cwd: this.#script.packageDir,
      dot: true,
      onlyFiles,
      absolute,
    });
    if (IS_WINDOWS) {
      // fast-glob returns paths with forward-slash as the delimiter, even on
      // Windows. Normalize so that they are always valid filesystem paths.
      for (let i = 0; i < files.length; i++) {
        files[i] = pathlib.normalize(files[i]);
      }
    }
    return files;
  }

  /**
   * Write this script's stdout replay to stdout if it exists, otherwise do
   * nothing.
   */
  async #replayStdoutIfPresent(): Promise<void> {
    try {
      for await (const chunk of createReadStream(this.#stdoutReplayPath)) {
        this.#logger.log({
          script: this.#script,
          type: 'output',
          stream: 'stdout',
          data: chunk as Buffer,
        });
      }
    } catch (error) {
      if ((error as {code?: string}).code === 'ENOENT') {
        // There is no saved replay.
        return;
      }
    }
  }

  /**
   * Write this script's stderr replay to stderr if it exists, otherwise do
   * nothing.
   */
  async #replayStderrIfPresent(): Promise<void> {
    try {
      for await (const chunk of createReadStream(this.#stderrReplayPath)) {
        this.#logger.log({
          script: this.#script,
          type: 'output',
          stream: 'stderr',
          data: chunk as Buffer,
        });
      }
    } catch (error) {
      if ((error as {code?: string}).code === 'ENOENT') {
        // There is no saved replay.
        return;
      }
      throw error;
    }
  }
}

/**
 * Close the given write stream and resolve or reject the returned promise when
 * completed or failed.
 */
const closeWriteStream = (stream: WriteStream): Promise<void> => {
  return new Promise((resolve, reject) => {
    stream.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
};

/**
 * If we are on Windows, convert back slashes to forward slashes (e.g. "foo\bar"
 * -> "foo/bar").
 */
const posixifyPathIfOnWindows = (path: string) =>
  IS_WINDOWS ? path.replaceAll(pathlib.win32.sep, pathlib.posix.sep) : path;
