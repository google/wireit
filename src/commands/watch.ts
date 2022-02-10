import {KnownError} from '../shared/known-error.js';
import {findNearestPackageJson} from '../shared/nearest-package-json.js';
import {analyze} from '../shared/analyze.js';
import chokidar from 'chokidar';
import {ScriptRunner} from './run.js';
import {hashReachablePackageLocks} from '../shared/hash-reachable-package-locks.js';
import * as pathlib from 'path';
import {Abort} from '../shared/abort.js';
import {FilesystemCache} from '../shared/filesystem-cache.js';
import {Deferred} from '../shared/deferred.js';

const parseArgs = (
  args: string[]
): {scriptName: string} => {
  let scriptName = process.env.npm_lifecycle_event;
  for (const arg of args) {
    if (arg.startsWith('--')) {
      throw new KnownError('invalid-argument', `Unknown watch flag ${arg}`);
    } else {
      scriptName = arg;
    }
  }
  if (scriptName === undefined) {
    throw new KnownError('invalid-argument', `No script to watch specified`);
  }
  return {scriptName, interrupt};
};

export default async (args: string[], abort: Promise<typeof Abort>) => {
  const {scriptName} = parseArgs(args);

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
  const pkgGlobs = new Map();
  await analyze(packageJsonPath, scriptName, pkgGlobs);

  // We want to create as few chokidar watchers as possible, but we need at
  // least one per cwd, because each globs need to be evaluated relative to its
  // cwd, and it's not possible (or is at least difficult and error-prone) to
  // turn relative globs into absolute ones (pathlib.resolve won't do it because
  // glob syntax is more complicated than standard path syntax).
  const globsByCwd = new Map<string, string[]>();
  for (const [cwd, globs] of pkgGlobs.entries()) {
    let arr = globsByCwd.get(cwd);
    if (arr === undefined) {
      arr = [];
      globsByCwd.set(cwd, arr);
    }
    arr.push(...globs);
  }

  // TODO(aomarks) We don't actually need the hashes here, just the filenames.
  const packageLocks = await hashReachablePackageLocks(
    pathlib.dirname(packageJsonPath)
  );
  for (const [lock] of packageLocks) {
    const cwd = pathlib.dirname(lock);
    let arr = globsByCwd.get(cwd);
    if (arr === undefined) {
      arr = [];
      globsByCwd.set(cwd, arr);
    }
    arr.push(pathlib.basename(lock));
  }

  const watcherPromises: Array<Promise<chokidar.FSWatcher>> = [];
  for (const [cwd, globs] of globsByCwd) {
    if (globs.length === 0) {
      // TODO(aomarks) Add a run test for this check. If you give chokidar an
      // empty set of globs, it never fires ready.
      continue;
    }
    const watcher = chokidar.watch(globs, {cwd, alwaysStat: true});
    watcherPromises.push(
      new Promise((resolve) => watcher.on('ready', () => resolve(watcher)))
    );
  }

  // Defer the first run until all chokidar watchers are ready.
  const watchers = await Promise.all(watcherPromises);

  let notification = new Deferred<void>();

  const debounce = 50;
  let lastFileChangeMs = (global as any).performance.now();
  for (const watcher of watchers) {
    watcher.on('all', () => {
      lastFileChangeMs = (global as any).performance.now();
      setTimeout(() => notification.resolve(), debounce);
    });
  }

  const runIgnoringScriptFailures = async () => {
    const runner = new ScriptRunner(abort, new FilesystemCache());
    try {
      await runner.run(packageJsonPath, scriptName, new Set());
    } catch (err) {
      if (
        !(
          err instanceof KnownError &&
          (err.code === 'script-failed' || err.code === 'script-cancelled')
        )
      ) {
        throw err;
      }
    }
  };

  // Always run initially.
  await runIgnoringScriptFailures();

  while (true) {
    const action = await Promise.race([notification.promise, abort]);
    if (action === Abort) {
      break;
    }
    notification = new Deferred();
    const now = (global as any).performance.now();
    const elapsed = now - lastFileChangeMs;
    if (elapsed >= debounce) {
      await runIgnoringScriptFailures();
    } else {
      setTimeout(() => notification.resolve(), debounce - elapsed);
    }
  }

  await Promise.all(watchers.map((watcher) => watcher.close()));
};
