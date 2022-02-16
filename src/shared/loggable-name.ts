import * as pathlib from 'path';

/**
 * Returns a `cwd` relative name for a script.
 */
export const loggableName = (packageJsonPath: string, scriptName: string) => {
  const dir = pathlib.dirname(packageJsonPath);
  if (dir === process.cwd()) {
    return scriptName;
  }
  return `${pathlib.basename(dir)}:${scriptName}`;
};
