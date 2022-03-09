/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import * as pathlib from 'path';
import {KnownError} from './known-error.js';
import fastglob from 'fast-glob';
import {readRawConfig} from './read-raw-config.js';
import {readPackageJson} from './read-package-json.js';

import type {ResolvedScriptReference} from '../types/config.js';

export const resolveDependency = async (
  packageJsonPath: string,
  specifier: string,
  referrerScriptName: string
): Promise<ResolvedScriptReference[]> => {
  let resolved;
  resolved ??= tryResolveRelativePathScript(packageJsonPath, specifier);
  resolved ??= await tryResolveWorkspacesScript(
    packageJsonPath,
    specifier,
    referrerScriptName
  );
  resolved ??= [{packageJsonPath, scriptName: specifier}];
  return resolved;
};

const tryResolveRelativePathScript = (
  packageJsonPath: string,
  specifier: string
): ResolvedScriptReference[] | undefined => {
  if (!specifier.startsWith('.')) {
    return;
  }
  // TODO(aomarks) Can a script actually start with "."? In that case, maybe we
  // require the syntax ":.foo". And if there is a script called ":.foo", then
  // we require "::.foo".
  const match = specifier.match(/([^:]+):(.+)$/);
  if (match == undefined) {
    throw new KnownError(
      'script-not-found',
      `Invalid script name: ${specifier}`
    );
  }
  const relativePath = match[1];
  specifier = match[2];
  packageJsonPath = pathlib.resolve(
    pathlib.dirname(packageJsonPath),
    relativePath,
    'package.json'
  );
  return [{scriptName: specifier, packageJsonPath}];
};

const tryResolveWorkspacesScript = async (
  packageJsonPath: string,
  specifier: string,
  referrerScriptName: string
): Promise<ResolvedScriptReference[] | undefined> => {
  const match = specifier.match(/^\$WORKSPACES(?::(.+))?$/);
  if (match === null) {
    return;
  }
  const workspaceScriptName = match[1] ?? referrerScriptName;
  const packageJson = await readPackageJson(packageJsonPath);
  const workspaces = await fastglob(packageJson.workspaces ?? [], {
    cwd: pathlib.dirname(packageJsonPath),
    onlyDirectories: true,
    absolute: true,
    // Workspace globs don't match .dotfiles by default.
    dot: false,
  });
  if (workspaces.length === 0) {
    throw new KnownError(
      'misconfigured',
      `No workspaces found in ${packageJsonPath}`
    );
  }
  const resolved = [];
  for (const workspace of workspaces) {
    const workspacePackageJsonPath = pathlib.join(workspace, 'package.json');
    const config = await readRawConfig(workspacePackageJsonPath);
    // TODO(aomarks) We silently ignore workspaces that are missing the script,
    // as long as at least one does. Is this the right behavior, or should we be
    // stricter by default like `npm run --workspaces` is, and have an
    // equivalent of the `--if-present` flag?
    if (config.scripts[workspaceScriptName] !== undefined) {
      resolved.push({
        packageJsonPath: workspacePackageJsonPath,
        scriptName: workspaceScriptName,
      });
    }
  }
  if (resolved.length === 0) {
    throw new KnownError(
      'misconfigured',
      `No workspaces of ${packageJsonPath} ` +
        `had a script named ${workspaceScriptName}`
    );
  }
  return resolved;
};
