import * as pathlib from 'path';

export function* iterateParentDirs(path: string): Iterable<string> {
  let child = path;
  let parent;
  do {
    yield child;
    parent = child;
    child = pathlib.dirname(child);
  } while (child !== '' && child !== parent);
}
