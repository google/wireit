import * as fs from 'fs/promises';

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

  // Wireit enabled scripts.
  const scripts = packageJson.wireit ?? {};

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
