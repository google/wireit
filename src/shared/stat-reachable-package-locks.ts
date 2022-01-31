import * as pathlib from 'path';
import * as fs from 'fs/promises';
import type {Stats} from 'fs';

/**
 * Finds all package-lock.json files in the given root directory, and all of
 * that directory's ancestors. Ordered from longest to shortest path.
 */
export const statReachablePackageLocks = async (
  root: string
): Promise<Array<[string, Stats]>> => {
  const promises = [];
  let cur = root;
  while (true) {
    const filename = pathlib.join(cur, 'package-lock.json');
    promises.push(
      (async () => {
        try {
          const stat = await fs.stat(filename);
          return [filename, stat];
        } catch (err) {
          if ((err as {code?: string}).code === 'ENOENT') {
            return undefined;
          }
          throw err;
        }
      })()
    );
    const parent = pathlib.dirname(cur);
    if (parent === '' || parent === cur) {
      break;
    }
    cur = parent;
  }
  const entries = await Promise.all(promises);
  return entries.filter((entry) => entry !== undefined) as Array<
    [string, Stats]
  >;
};
