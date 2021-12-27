import { KnownError } from "../shared/known-error.js";
import { findNearestPackageJson } from "../shared/nearest-package-json.js";
import { analyze } from "../shared/analyze.js";
import chokidar from "chokidar";
import { TaskRunner } from "./run.js";

export default async (args: string[]) => {
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
  const ready = [];
  let r = false;
  const onChange = async (ev: unknown, path: unknown) => {
    if (!r) {
      return;
    }
    console.log("CHANGE DETECTED", ev, path);
    const runner = new TaskRunner();
    await runner.run(packageJsonPath, taskName, new Set());
    await runner.writeStates();
  };
  for (const [cwd, globs] of pkgGlobs.entries()) {
    const watcher = chokidar.watch(globs, { cwd });
    watcher.on("all", onChange);
    ready.push(
      new Promise<void>((resolve) => {
        watcher.on("ready", () => {
          resolve();
        });
      })
    );
  }
  await Promise.all(ready);
  r = true;
  console.log("ready");
};
