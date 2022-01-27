import {KnownError} from '../shared/known-error.js';
import {findNearestPackageJson} from '../shared/nearest-package-json.js';
import {analyze} from '../shared/analyze.js';
import chokidar from 'chokidar';
import {TaskRunner, CommandFailedError} from './run.js';
import {statReachablePackageLock} from '../shared/stat-reachable-package-locks.js';
import * as pathlib from 'path';
import {AbortManager} from '../shared/aborted.js';

export default async (args: string[], aborted: AbortManager) => {
  if (args.length !== 1 && process.env.npm_lifecycle_event === undefined) {
    throw new KnownError(`Expected 1 argument but got ${args.length}`);
  }
  const packageJsonPath =
    process.env.npm_package_json ??
    (await findNearestPackageJson(process.cwd()));
  if (packageJsonPath === undefined) {
    throw new KnownError(
      `Could not find a package.json in ${process.cwd()} or parents`
    );
  }
  const taskName = args[0] ?? process.env.npm_lifecycle_event;
  const pkgGlobs = new Map();
  await analyze(packageJsonPath, taskName, pkgGlobs);

  // TODO(aomarks) Pretty sure this is not quite correct. Especially the case:
  //
  // 1. Build A starts
  // 2. File changed
  // 3. <debounce expires>
  // 4. File changed
  // 5. Build B starts, but without waiting for <debounce expires>
  //
  // Can probably be simplified too.
  let buildIsWaitingToStart = false;
  let activeBuild: Promise<void> | undefined;
  const run = async () => {
    if (buildIsWaitingToStart) {
      return;
    }
    if (activeBuild !== undefined) {
      await activeBuild;
    } else {
    }
    buildIsWaitingToStart = false;
    activeBuild = new Promise(async (resolve) => {
      const runner = new TaskRunner(aborted);
      try {
        await runner.run(packageJsonPath, taskName, new Set());
        await runner.writeStates();
      } catch (err) {
        if (err instanceof CommandFailedError) {
          console.error(`Task failed: ${err.message}`);
        } else {
          throw err;
        }
      } finally {
        resolve();
        activeBuild = undefined;
      }
    });
  };

  const debounce = 50;
  let nextRunTimeout: ReturnType<typeof setTimeout> | undefined = undefined;
  const invalidate = () => {
    if (nextRunTimeout !== undefined) {
      clearTimeout(nextRunTimeout);
    }
    nextRunTimeout = setTimeout(run, debounce);
  };

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

  const packageLocks = await statReachablePackageLock(
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
  for (const watcher of watchers) {
    watcher.on('all', () => invalidate());
  }

  // Always run initially.
  invalidate();
};
