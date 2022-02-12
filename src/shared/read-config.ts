import * as fs from 'fs/promises';
import {KnownError} from './known-error.js';
import fastglob from 'fast-glob';
import * as pathlib from 'path';

import type {PackageJson, Config} from '../types/config.js';

export const readConfig = async (packageJsonPath: string): Promise<Config> => {
  let packageJsonStr;
  try {
    packageJsonStr = await fs.readFile(packageJsonPath, 'utf8');
  } catch (e) {
    throw new Error(
      `Could not read package.json file ${packageJsonPath}:` +
        ` ${(e as Error).message}`
    );
  }

  let packageJson: PackageJson;
  try {
    packageJson = JSON.parse(packageJsonStr);
  } catch (e) {
    throw new Error(
      `Invalid JSON in package.json ${packageJsonPath}: ` +
        ` ${(e as Error).message}`
    );
  }

  // Require that any "wireit" script also be in the "scripts" section, and that
  // it delegates to the "wireit" binary.
  //
  // The main reason for this requirement is to remove a footgun with `npm run
  // --workspaces`. If we did not have this requirement, then it would be easy
  // to define a script in the "wireit" section of the package.json, but forget
  // to include it in the "scripts" list. When the user then runs `npm run foo
  // --workspaces --if-present`, they might expect the wireit script to run, but
  // npm would in fact never find it.
  for (const scriptName of Object.keys(packageJson.wireit ?? {})) {
    const npmScript = packageJson.scripts?.[scriptName];
    if (npmScript === undefined) {
      throw new KnownError(
        'missing-npm-script',
        `${scriptName} is configured in the "wireit" section ` +
          `of ${packageJsonPath}, but not the "scripts" section.`
      );
    }
    if (npmScript !== 'wireit') {
      throw new KnownError(
        'misconfigured-npm-script',
        `${scriptName} is configured in the "wireit" section ` +
          `of ${packageJsonPath}, but the "scripts" command ` +
          `is "${npmScript}" instead of "wireit".`
      );
    }
  }

  // TODO(aomarks) This resolution logic is super inefficient.
  const scripts = packageJson.wireit ?? {};
  for (const [scriptName, scriptConfig] of Object.entries(scripts)) {
    const resolvedDependencies: string[] = [];
    for (const dep of scriptConfig.dependencies ?? []) {
      const workspacesMatch = dep.match(/^\$WORKSPACES(?::(.+))?$/);
      if (workspacesMatch !== null) {
        const script = workspacesMatch[1] ?? scriptName;
        const workspaces = await fastglob(packageJson.workspaces ?? [], {
          cwd: pathlib.dirname(packageJsonPath),
          onlyDirectories: true,
          absolute: true,
        });
        for (const workspace of workspaces) {
          const workspaceConfig = await readConfig(
            pathlib.join(workspace, 'package.json')
          );
          if (workspaceConfig.scripts?.[script] !== undefined) {
            // TODO(aomarks) It seems silly to have to build a <path>:<script>
            // syntax here. We should have a structured format.
            resolvedDependencies.push(
              './' +
                pathlib.relative(pathlib.dirname(packageJsonPath), workspace) +
                ':' +
                script
            );
          }
        }
      } else {
        resolvedDependencies.push(dep);
      }
    }
    scriptConfig.dependencies = resolvedDependencies;
  }

  // Vanilla scripts are scripts too. They just won't have any freshness,
  // caching, or watch support.
  if (packageJson.scripts !== undefined) {
    for (const [scriptName, command] of Object.entries(packageJson.scripts)) {
      if (scripts[scriptName] === undefined) {
        scripts[scriptName] = {
          command,
        };
      }
    }
  }

  return {
    packageJsonPath,
    scripts,
  };
};
