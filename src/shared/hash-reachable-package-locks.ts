import * as pathlib from 'path';
import * as fs from 'fs/promises';
import {createHash} from 'crypto';

/**
 * Finds all package-lock.json files in the given root directory, and all of
 * that directory's ancestors, and return tuples of [filename, sha256 hash].
 * Ordered from longest to shortest path.
 */
export const hashReachablePackageLocks = async (
  root: string
): Promise<Array<[string, {sha256: string}]>> => {
  const promises = [];
  let cur = root;
  while (true) {
    const filename = pathlib.join(cur, 'package-lock.json');
    promises.push(
      (async () => {
        let content;
        try {
          content = await fs.readFile(filename, 'utf8');
        } catch (err) {
          if ((err as {code?: string}).code === 'ENOENT') {
            return undefined;
          }
          throw err;
        }
        const sha256 = createHash('sha256').update(content).digest('hex');
        return [filename, {sha256}];
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
    [string, {sha256: string}]
  >;
};
