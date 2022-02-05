import {KnownError} from '../shared/known-error.js';
import {findNearestPackageJson} from '../shared/nearest-package-json.js';
import {analyze} from '../shared/analyze.js';
import chokidar from 'chokidar';
import {TaskRunner} from './run.js';
import {hashReachablePackageLocks} from '../shared/hash-reachable-package-locks.js';
import * as pathlib from 'path';
import {Abort} from '../shared/abort.js';
import {FilesystemCache} from '../shared/filesystem-cache.js';

export default async (args: string[], abort: Promise<typeof Abort>) => {
  if (args.length !== 1 && process.env.npm_lifecycle_event === undefined) {
    throw new KnownError(
      'invalid-argument',
      `Expected 1 argument but got ${args.length}`
    );
  }
  const packageJsonPath =
    process.env.npm_package_json ??
    (await findNearestPackageJson(process.cwd()));
  if (packageJsonPath === undefined) {
    throw new KnownError(
      'invalid-argument',
      `Could not find a package.json in ${process.cwd()} or parents`
    );
  }
  const taskName = args[0] ?? process.env.npm_lifecycle_event;
  const pkgGlobs = new Map();
  await analyze(packageJsonPath, taskName, pkgGlobs);

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

  let resolveNotification!: () => void;
  let notification = new Promise<void>((resolve) => {
    resolveNotification = resolve;
  });

  const debounce = 50;
  let lastFileChangeMs = (global as any).performance.now();
  for (const watcher of watchers) {
    watcher.on('all', () => {
      lastFileChangeMs = (global as any).performance.now();
      setTimeout(() => resolveNotification(), debounce);
    });
  }

  const runIgnoringTaskFailures = async () => {
    // TODO(aomarks) Should the filesystem cache be shared between runs?
    const runner = new TaskRunner(abort, new FilesystemCache());
    try {
      await runner.run(packageJsonPath, taskName, new Set());
    } catch (err) {
      if (
        !(
          err instanceof KnownError &&
          (err.code === 'task-failed' || err.code === 'task-cancelled')
        )
      ) {
        throw err;
      }
    }
  };

  // Always run initially.
  await runIgnoringTaskFailures();

  while (true) {
    const action = await Promise.race([notification, abort]);
    if (action === Abort) {
      break;
    }
    notification = new Promise<void>((resolve) => {
      resolveNotification = resolve;
    });
    const now = (global as any).performance.now();
    const elapsed = now - lastFileChangeMs;
    if (elapsed >= debounce) {
      await runIgnoringTaskFailures();
    } else {
      setTimeout(() => resolveNotification(), debounce - elapsed);
    }
  }

  await Promise.all(watchers.map((watcher) => watcher.close()));
};
