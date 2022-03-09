/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {KnownError} from '../shared/known-error.js';
import {readRawConfig} from './read-raw-config.js';
import {resolveDependency} from '../shared/resolve-script.js';
import * as pathlib from 'path';
import {loggableName} from '../shared/loggable-name.js';

export const analyze = async (
  packageJsonPath: string,
  scriptName: string,
  globs: Map<string, string[]>
) => {
  const config = await readRawConfig(packageJsonPath);
  const script = config.scripts[scriptName];
  if (script === undefined) {
    throw new KnownError(
      'script-not-found',
      `[${loggableName(
        packageJsonPath,
        scriptName
      )}] No such script ${scriptName} in ${packageJsonPath}`
    );
  }
  const promises = [];
  for (const dep of script.dependencies ?? []) {
    for (const resolved of await resolveDependency(
      packageJsonPath,
      dep,
      scriptName
    )) {
      promises.push(
        analyze(resolved.packageJsonPath, resolved.scriptName, globs)
      );
    }
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
