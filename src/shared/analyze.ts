import { KnownError } from "../shared/known-error.js";
import { readConfig } from "../shared/read-config.js";
import { resolveTask } from "../shared/resolve-task.js";
import * as pathlib from "path";

export const analyze = async (
  packageJsonPath: string,
  taskName: string,
  globs: Map<string, string[]>
) => {
  const config = await readConfig(packageJsonPath);
  const task = config.tasks?.[taskName];
  if (task === undefined) {
    throw new KnownError(`No such task ${taskName} in ${packageJsonPath}`);
  }
  const promises = [];
  for (const dep of task.dependencies ?? []) {
    const resolved = resolveTask(packageJsonPath, dep);
    promises.push(analyze(resolved.packageJsonPath, resolved.taskName, globs));
  }
  await Promise.all(promises);
  const root = pathlib.dirname(packageJsonPath);
  let arr = globs.get(root);
  if (arr === undefined) {
    arr = [];
    globs.set(root, arr);
  }
  if (task.files !== undefined) {
    arr.push(...task.files);
  }
};
