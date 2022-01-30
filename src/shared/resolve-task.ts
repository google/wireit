import * as pathlib from 'path';
import {KnownError} from './known-error.js';

export const resolveTask = (
  packageJsonPath: string,
  taskName: string
): {packageJsonPath: string; taskName: string} => {
  if (taskName.startsWith('.')) {
    const match = taskName.match(/([^:]+):(.+)$/);
    if (match == undefined) {
      throw new KnownError('task-not-found', `Invalid task name: ${taskName}`);
    }
    const relativePath = match[1];
    taskName = match[2];
    packageJsonPath = pathlib.resolve(
      pathlib.dirname(packageJsonPath),
      relativePath,
      'package.json'
    );
  }
  return {packageJsonPath, taskName};
};
