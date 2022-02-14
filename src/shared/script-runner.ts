import {KnownError} from '../shared/known-error.js';
import {readRawConfig} from './read-raw-config.js';
import {spawn} from 'child_process';
import * as pathlib from 'path';
import fastglob from 'fast-glob';
import {resolveDependency} from '../shared/resolve-script.js';
import {hashReachablePackageLocks} from '../shared/hash-reachable-package-locks.js';
import * as fs from 'fs/promises';
import {createHash} from 'crypto';
import {ReservationPool} from '../shared/reservation-pool.js';

import type {Cache} from '../shared/cache.js';
import type {RawPackageConfig, RawScript} from '../types/config.js';

interface ScriptStatus {
  cacheKey: CacheKey;
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
}

// TODO(aomarks) What about permission bits?
interface FileContentHash {
  sha256: string;
}

export class ScriptRunner {
  private readonly _configs = new Map<string, Promise<RawPackageConfig>>();
  private readonly _scriptPromises = new Map<string, Promise<ScriptStatus>>();
  private readonly _abort: Promise<unknown>;
  private readonly _cache: Cache;
  private readonly _parallelismLimiter: ReservationPool;

  constructor(abort: Promise<unknown>, cache: Cache, parallel: number) {
    this._abort = abort;
    this._cache = cache;
    this._parallelismLimiter = new ReservationPool(parallel);
  }

  /**
   * @returns A promise that resolves to true if the script ran, otherwise false.
   */
  async run(
    packageJsonPath: string,
    scriptName: string,
    stack: Set<string>
  ): Promise<ScriptStatus> {
    const scriptId = JSON.stringify([packageJsonPath, scriptName]);
    if (stack.has(scriptId)) {
      throw new KnownError(
        'cycle',
        `Cycle detected at script ${scriptName} in ${packageJsonPath}`
      );
    }

    let promise = this._scriptPromises.get(scriptId);
    if (promise === undefined) {
      promise = this._run(packageJsonPath, scriptName, stack);
      this._scriptPromises.set(scriptId, promise);
    }
    return promise;
  }

  async _run(
    packageJsonPath: string,
    scriptName: string,
    stack: Set<string>
  ): Promise<ScriptStatus> {
    const scriptId = JSON.stringify([packageJsonPath, scriptName]);
    const script = await this._findScript(packageJsonPath, scriptName);

    const newCacheKeyData: CacheKey = {
      command: script.command!, // TODO(aomarks) This shouldn't be undefined.
      files: {},
      dependencies: {},
      npmPackageLocks: {},
      outputGlobs: script.output ?? [],
    };

    if (script.dependencies?.length) {
      const resolvedDependencies = (
        await Promise.all(
          script.dependencies.map(
            async (depSpecifier) =>
              await resolveDependency(packageJsonPath, depSpecifier, scriptName)
          )
        )
      ).flat();

      // IMPORTANT: We must sort here, because it's important that the insertion
      // order of dependency entries in our cache key is deterministic.
      resolvedDependencies.sort((a, b) => {
        if (a.packageJsonPath !== b.packageJsonPath) {
          return a.packageJsonPath.localeCompare(b.packageJsonPath);
        }
        return a.scriptName.localeCompare(b.scriptName);
      });

      // Note we use Promise.allSettled() instead of Promise.all() here because
      // we want don't want our top-level script to throw until all sub-scripts
      // have had a chance to clean up in the case of a failure.
      const depResults = await Promise.allSettled(
        resolvedDependencies.map((dep) =>
          this.run(
            dep.packageJsonPath,
            dep.scriptName,
            new Set(stack).add(scriptId)
          )
        )
      );
      for (let i = 0; i < depResults.length; i++) {
        const result = depResults[i];
        if (result.status === 'rejected') {
          // TODO(aomarks) There could be multiple failures, but we'll only show
          // an arbitrary one.
          throw result.reason;
        }
        const scriptReference = resolvedDependencies[i];
        const cacheKeyName =
          scriptReference.packageJsonPath === packageJsonPath
            ? scriptReference.scriptName
            : `${pathlib.relative(
                pathlib.dirname(packageJsonPath),
                scriptReference.packageJsonPath
              )}:${scriptReference.scriptName}`;
        newCacheKeyData.dependencies[cacheKeyName] = result.value.cacheKey;
      }
    }

    if (script.files?.length) {
      const entries = await fastglob(script.files, {
        cwd: pathlib.dirname(packageJsonPath),
        dot: true,
        followSymbolicLinks: false,
      });

      // IMPORTANT: We must sort here, because it's important that the insertion
      // order of file entries in our cache key is deterministic.
      entries.sort((a, b) => a.localeCompare(b));

      const fileHashPromises: Array<Promise<string>> = [];
      for (const entry of entries) {
        fileHashPromises.push(
          fs
            .readFile(
              pathlib.resolve(pathlib.dirname(packageJsonPath), entry),
              'utf8'
            )
            .then((content) =>
              createHash('sha256').update(content).digest('hex')
            )
        );
      }
      const fileHashes = await Promise.all(fileHashPromises);

      for (let i = 0; i < entries.length; i++) {
        newCacheKeyData.files[entries[i]] = {
          sha256: fileHashes[i],
        };
      }
    }

    if (script.checkPackageLocks ?? true) {
      const packageLockHashes = await hashReachablePackageLocks(
        pathlib.dirname(packageJsonPath)
      );

      newCacheKeyData.npmPackageLocks = Object.fromEntries(
        packageLockHashes.map(([filename, sha256]) => [filename, {sha256}])
      );
    }

    const newCacheKey = JSON.stringify(newCacheKeyData);

    if (script.files !== undefined) {
      // Only check for freshness if input files are defined. This requires the
      // user to explicitly tell us when there are no input files to enable
      // skipping scripts that are already fresh. If it's undefined, the user
      // might not have gotten around to specifying the input files yet, so it's
      // safer to assume that the inputs could be anything, and hence always
      // might have changed.
      const existingFsCacheKey = await this._readCurrentState(
        packageJsonPath,
        scriptName
      );

      const cacheKeyStale = newCacheKey !== existingFsCacheKey;
      if (!cacheKeyStale) {
        console.log(`🥬 [${scriptName}] Already fresh!`);
        return {cacheKey: newCacheKeyData};
      }
    }

    // TODO(aomarks) What should we do if there's no command, but there is
    // files/output? This is valid, and affects whether we report things as
    // cached, and whether we clear outputfiles.
    if (script.command) {
      // TODO(aomarks) We should race against abort here too (any expensive operation).
      let cachedOutput;

      if (script.output !== undefined) {
        if (script.deleteOutputBeforeEachRun ?? true) {
          // Delete any existing output files.
          const existingOutputFiles = await fastglob(script.output, {
            cwd: pathlib.dirname(packageJsonPath),
            dot: true,
            followSymbolicLinks: false,
          });
          if (existingOutputFiles.length > 0) {
            console.log(
              `🗑️ [${scriptName}] Deleting ${existingOutputFiles.length} existing output file(s)`
            );
            await Promise.all([
              existingOutputFiles.map((file) =>
                fs.rm(file, {recursive: true, force: true})
              ),
            ]);
          }
        }

        if (this._cache !== undefined) {
          // Only cache if output files are defined. This requires the user to
          // explicitly tell us when there are no output files to enable
          // caching. If it's undefined, the user might not have gotten around
          // to specifying the output yet, so it's safer to assume that the
          // output could be anything, and we wouldn't otherwise capture them
          // correctly.
          cachedOutput = await this._cache.getOutput(
            packageJsonPath,
            scriptName,
            newCacheKey,
            script.output
          );
        }
      }
      if (cachedOutput !== undefined) {
        console.log(`♻️ [${scriptName}] Restoring from cache`);
        await cachedOutput.apply();
      } else {
        // Delete the current state before we start running, because if there
        // was a previously successful run in a different state, and this run
        // fails, then the next time we run, we would otherwise incorrectly
        // think that the script was still fresh with the previous state
        await this._clearCurrentState(packageJsonPath, scriptName);
        // We run scripts via npx so that PATH will include the
        // node_modules/.bin directory, matching the standard behavior of an NPM
        // script. This also gives access to other NPM-specific environment
        // variables that a user's script might need.
        const releaseParallelismReservation =
          await this._parallelismLimiter.reserve();
        console.log(`🏃 [${scriptName}] Running command`);
        const child = spawn('npx', ['-c', script.command], {
          cwd: pathlib.dirname(packageJsonPath),
          stdio: 'inherit',
          detached: true,
        });
        const completed = new Promise<void>((resolve, reject) => {
          // TODO(aomarks) Do we need to handle "close"? Is there any way a
          // "close" event can be fired, but not an "exit" or "error" event?
          child.on('error', () => {
            console.log(`❌ [${scriptName}] Failed to start`);
            reject(
              new KnownError(
                'script-control-error',
                `Command ${scriptName} failed to start`
              )
            );
          });
          child.on('exit', (code, signal) => {
            if (signal !== null) {
              console.log(`❌ [${scriptName}] Exited with signal ${code}`);
              reject(
                new KnownError(
                  'script-cancelled',
                  `Command ${scriptName} exited with signal ${code}`
                )
              );
            } else if (code !== 0) {
              console.log(`❌ [${scriptName}] Failed with code ${code}`);
              reject(
                new KnownError(
                  'script-failed',
                  `Command ${scriptName} failed with code ${code}`
                )
              );
            } else {
              resolve();
            }
          });
        }).then(() => releaseParallelismReservation());
        const result = await Promise.race([
          completed,
          this._abort.then(() => 'abort'),
        ]);
        if (result === 'abort') {
          console.log(`💀 [${scriptName}] Killing`);
          process.kill(-child.pid!, 'SIGINT');
          await completed;
          throw new Error(
            `Unexpected internal error. Script ${scriptName} should have thrown.`
          );
        }
        console.log(`✅ [${scriptName}] Succeeded`);
        if (this._cache !== undefined && script.output !== undefined) {
          // TODO(aomarks) Shouldn't need to block on this finishing.
          await this._cache.saveOutput(
            packageJsonPath,
            scriptName,
            newCacheKey,
            script.output
          );
        }
      }
    }

    if (script.files !== undefined) {
      await this._writeCurrentState(packageJsonPath, scriptName, newCacheKey);
    }

    return {cacheKey: newCacheKeyData};
  }

  private async _findScript(
    packageJsonPath: string,
    scriptName: string
  ): Promise<RawScript> {
    const rawConfig = await this._getRawConfig(packageJsonPath);
    const script = rawConfig.scripts?.[scriptName];
    if (script === undefined) {
      throw new KnownError(
        'script-not-found',
        `Could not find script ${scriptName} in ${packageJsonPath}`
      );
    }
    return script;
  }

  private async _getRawConfig(
    packageJsonPath: string
  ): Promise<RawPackageConfig> {
    let promise = this._configs.get(packageJsonPath);
    if (promise === undefined) {
      promise = readRawConfig(packageJsonPath);
      this._configs.set(packageJsonPath, promise);
    }
    return promise;
  }

  private async _readCurrentState(
    packageJsonPath: string,
    scriptName: string
  ): Promise<string | undefined> {
    const stateFile = pathlib.resolve(
      pathlib.dirname(packageJsonPath),
      '.wireit',
      'state',
      scriptName
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

  private async _clearCurrentState(
    packageJsonPath: string,
    scriptName: string
  ): Promise<void> {
    const stateFile = pathlib.resolve(
      pathlib.dirname(packageJsonPath),
      '.wireit',
      'state',
      scriptName
    );
    await fs.rm(stateFile, {force: true});
  }

  private async _writeCurrentState(
    packageJsonPath: string,
    scriptName: string,
    state: string
  ): Promise<void> {
    const stateFile = pathlib.resolve(
      pathlib.dirname(packageJsonPath),
      '.wireit',
      'state',
      scriptName
    );
    await fs.mkdir(pathlib.dirname(stateFile), {recursive: true});
    return fs.writeFile(stateFile, state, 'utf8');
  }
}
