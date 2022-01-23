import * as pathlib from 'path';
import * as fs from 'fs/promises';

export const findNearestPackageJson = async (
  dir: string
): Promise<string | undefined> => {
  dir = pathlib.resolve(dir);
  while (true) {
    let path = pathlib.join(dir, 'package.json');
    try {
      await fs.stat(path);
      return path;
    } catch (e) {
      if ((e as Error & {code: string}).code !== 'ENOENT') {
        throw e;
      }
    }
    const parent = pathlib.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
};
