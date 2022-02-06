import {KnownError} from '../shared/known-error.js';
import {readConfig} from '../shared/read-config.js';
import {resolveScript} from '../shared/resolve-script.js';
import * as pathlib from 'path';

export const analyze = async (
  packageJsonPath: string,
  scriptName: string,
  globs: Map<string, string[]>
) => {
  const config = await readConfig(packageJsonPath);
  const script = config.scripts?.[scriptName];
  if (script === undefined) {
    throw new KnownError(
      'script-not-found',
      `No such script ${scriptName} in ${packageJsonPath}`
    );
  }
  const promises = [];
  for (const dep of script.dependencies ?? []) {
    const resolved = resolveScript(packageJsonPath, dep);
    promises.push(
      analyze(resolved.packageJsonPath, resolved.scriptName, globs)
    );
  }
  await Promise.all(promises);
  const root = pathlib.dirname(packageJsonPath);
  let arr = globs.get(root);
  if (arr === undefined) {
    arr = [];
    globs.set(root, arr);
  }
  if (script.files !== undefined) {
    arr.push(...script.files);
  }
};
