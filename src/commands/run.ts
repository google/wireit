import {KnownError} from '../shared/known-error.js';
import {readConfig} from '../shared/read-config.js';
import {spawn} from 'child_process';
import * as pathlib from 'path';
import {findNearestPackageJson} from '../shared/nearest-package-json.js';
import fastglob from 'fast-glob';
import {resolveScript} from '../shared/resolve-script.js';
import {hashReachablePackageLocks} from '../shared/hash-reachable-package-locks.js';
import {Abort} from '../shared/abort.js';
import {FilesystemCache} from '../shared/filesystem-cache.js';
import {GitHubCache} from '../shared/github-cache.js';
import * as fs from 'fs/promises';
import {createHash} from 'crypto';

import type {Cache} from '../shared/cache.js';
import type {Config, Script} from '../types/config.js';

export default async (args: string[], abort: Promise<typeof Abort>) => {
  if (args.length !== 1 && process.env.npm_lifecycle_event === undefined) {
    throw new KnownError(
      'invalid-argument',
      `Expected 1 argument but got ${args.length}`
    );
  }

  // We could check process.env.npm_package_json here, but it's actually wrong
  // in some cases. E.g. when we invoke wireit from one npm script, but we're
  // asking it to evaluate another directory.
  const packageJsonPath = await findNearestPackageJson(process.cwd());
  if (packageJsonPath === undefined) {
    throw new KnownError(
      'invalid-argument',
      `Could not find a package.json in ${process.cwd()} or parents`
    );
  }

  const cache = process.env.GITHUB_CACHE
    ? new GitHubCache()
    : new FilesystemCache();
  const runner = new ScriptRunner(abort, cache);
  const scriptName = args[0] ?? process.env.npm_lifecycle_event;
  await runner.run(packageJsonPath, scriptName, new Set());
};

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
  private readonly _configs = new Map<string, Promise<Config>>();
  private readonly _scriptPromises = new Map<string, Promise<ScriptStatus>>();
  private readonly _abort: Promise<typeof Abort>;
  private readonly _cache: Cache;

  constructor(abort: Promise<typeof Abort>, cache: Cache) {
    this._abort = abort;
    this._cache = cache;
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
    if (promise !== undefined) {
      return promise;
    }
    let resolve: (value: ScriptStatus) => void;
    promise = new Promise<ScriptStatus>((r) => (resolve = r));
    this._scriptPromises.set(scriptId, promise);

    const {config, script} = await this._findConfigAndScript(
      packageJsonPath,
      scriptName
    );

    const newCacheKeyData: CacheKey = {
      command: script.command!, // TODO(aomarks) This shouldn't be undefined.
      files: {},
      dependencies: {},
      npmPackageLocks: {},
      outputGlobs: script.output ?? [],
    };

    if (script.dependencies?.length) {
      // IMPORTANT: We must sort here, because it's important that the insertion
      // order of dependency entries in our cache key is deterministic.
      script.dependencies.sort((a, b) => a.localeCompare(b));

      const depScriptPromises = [];
      for (const depScriptName of script.dependencies) {
        depScriptPromises.push(
          this.run(
            config.packageJsonPath,
            depScriptName,
            new Set(stack).add(scriptId)
          )
        );
      }
      // Note we use Promise.allSettled() instead of Promise.all() here because
      // we want don't want our top-level script to throw until all sub-scripts
      // have had a chance to clean up in the case of a failure.
      const results = await Promise.allSettled(depScriptPromises);
      for (let i = 0; i < script.dependencies.length; i++) {
        const depScriptName = script.dependencies[i];
        const result = results[i];
        if (result.status === 'rejected') {
          // TODO(aomarks) There could be multiple failures, but we'll only show
          // an arbitrary one.
          throw result.reason;
        }
        newCacheKeyData.dependencies[depScriptName] = result.value.cacheKey;
      }
    }

    if (script.files?.length) {
      const entries = await fastglob(script.files, {
        cwd: pathlib.dirname(config.packageJsonPath),
      });

      // IMPORTANT: We must sort here, because it's important that the insertion
      // order of file entries in our cache key is deterministic.
      entries.sort((a, b) => a.localeCompare(b));

      const fileHashPromises: Array<Promise<string>> = [];
      for (const entry of entries) {
        // TODO(aomarks) A test case to confirm that we are reading from the
        // right directory (it passed a test, but failed in reality).
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
    const existingFsCacheKey = await this._readCurrentState(
      config.packageJsonPath,
      scriptName
    );

    const cacheKeyStale = newCacheKey !== existingFsCacheKey;
    if (!cacheKeyStale) {
      console.log(`🔌 [${scriptName}] Already up to date`);
      resolve!({cacheKey: newCacheKeyData});
      return promise;
    }

    if (script.command) {
      // TODO(aomarks) We should race against abort here too (any expensive operation).
      // TODO(aomarks) What should we be doing when there is a cache but a script has no output? What about empty array output vs undefined?
      let cachedOutput;
      if (this._cache !== undefined) {
        cachedOutput = await this._cache.getOutput(
          packageJsonPath,
          scriptName,
          newCacheKey,
          script.output ?? []
        );
      }
      if (cachedOutput !== undefined) {
        console.log(`🔌 [${scriptName}] Restoring from cache`);
        await cachedOutput.apply();
      } else {
        console.log(`🔌 [${scriptName}] Running command`);
        // We run scripts via npx so that PATH will include the
        // node_modules/.bin directory, matching the standard behavior of an NPM
        // script. This also gives access to other NPM-specific environment
        // variables that a user's script might need.
        const child = spawn('npx', ['-c', script.command], {
          cwd: pathlib.dirname(config.packageJsonPath),
          stdio: 'inherit',
          detached: true,
        });
        const completed = new Promise<void>((resolve, reject) => {
          // TODO(aomarks) Do we need to handle "close"? Is there any way a
          // "close" event can be fired, but not an "exit" or "error" event?
          child.on('error', () => {
            console.log(`🔌 [${scriptName}] Failed to start`);
            reject(
              new KnownError(
                'script-control-error',
                `Command ${scriptName} failed to start`
              )
            );
          });
          child.on('exit', (code, signal) => {
            if (signal !== null) {
              console.log(`🔌 [${scriptName}] Exited with signal ${code}`);
              reject(
                new KnownError(
                  'script-cancelled',
                  `Command ${scriptName} exited with signal ${code}`
                )
              );
            } else if (code !== 0) {
              console.log(`🔌 [${scriptName}] Failed with code ${code}`);
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
        });
        const result = await Promise.race([completed, this._abort]);
        if (result === Abort) {
          console.log(`🔌 [${scriptName}] Killing`);
          process.kill(-child.pid!, 'SIGINT');
          await completed;
          throw new Error(
            `Unexpected internal error. Script ${scriptName} should have thrown.`
          );
        }
        console.log(`🔌 [${scriptName}] Completed`);
        if (this._cache !== undefined) {
          // TODO(aomarks) Shouldn't need to block on this finishing.
          await this._cache.saveOutput(
            packageJsonPath,
            scriptName,
            newCacheKey,
            script.output ?? []
          );
        }
      }
    }

    await this._writeCurrentState(
      config.packageJsonPath,
      scriptName,
      newCacheKey
    );

    resolve!({cacheKey: newCacheKeyData});
    return promise;
  }

  private async _findConfigAndScript(
    packageJsonPath: string,
    scriptName: string
  ): Promise<{config: Config; script: Script}> {
    const resolved = resolveScript(packageJsonPath, scriptName);
    packageJsonPath = resolved.packageJsonPath;
    scriptName = resolved.scriptName;
    const config = await this._getConfig(packageJsonPath);
    const script = config.scripts?.[scriptName];
    if (script === undefined) {
      throw new KnownError(
        'script-not-found',
        `Could not find script ${scriptName} in ${packageJsonPath}`
      );
    }
    return {config, script};
  }

  private async _getConfig(packageJsonPath: string): Promise<Config> {
    let promise = this._configs.get(packageJsonPath);
    if (promise === undefined) {
      promise = readConfig(packageJsonPath);
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
