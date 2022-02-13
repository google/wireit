import {sep} from 'path';

export const expandGlobCurlyGroups = (glob: string): string[] => {
  const curlyStart = glob.indexOf('{');
  if (curlyStart === -1) {
    return [glob];
  }
  const curlyEnd = glob.indexOf('}');
  if (curlyEnd === -1 || curlyEnd < curlyStart) {
    return [glob];
  }
  const expanded = [];
  const parts = glob.slice(curlyStart + 1, curlyEnd).split(',');
  for (const part of parts) {
    expanded.push(
      ...expandGlobCurlyGroups(
        glob.slice(0, curlyStart) + part + glob.slice(curlyEnd + 1)
      )
    );
  }
  return expanded;
};

/**
 * Re-writes the given glob so that it is relative to the given directory.
 *
 * Example:
 *
 *      glob: src/**\/*.js
 *       cwd: packages/foo
 *   returns: packages/foo/src/**\/*.js
 *
 *      glob: !src/ignore.js
 *       cwd: packages/foo
 *   returns: !packages/foo/src/ignore.js
 */
export const changeGlobDirectory = (glob: string, cwd: string): string => {
  if (glob.startsWith('!')) {
    return '!' + changeGlobDirectory(glob.slice(1), cwd);
  }
  if (cwd === '') {
    return glob;
  }
  if (glob.startsWith('/')) {
    return glob;
  }
  if (glob.startsWith('{')) {
    // TODO(aomarks) There are probably some problems here with escaping edge
    // cases, e.g. files that literally contain "{" characters that are escaped
    // inside of curly braces.
    const endGroup = glob.indexOf('}');
    if (endGroup !== -1) {
      const parts = glob.slice(1, endGroup).split(',');
      if (parts.some((part) => part.startsWith('/'))) {
        return (
          '{' +
          parts.map((part) => changeGlobDirectory(part, cwd)).join(',') +
          '}' +
          glob.slice(endGroup + 1)
        );
      }
    }
  }
  return cwd + sep + glob;
};
