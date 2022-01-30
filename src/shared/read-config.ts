import * as fs from 'fs/promises';
import {KnownError} from './known-error.js';

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

  const config = packageJson.wireit;
  if (config === undefined) {
    throw new KnownError(
      'task-not-found',
      `No wireit config in package.json ${packageJsonPath}`
    );
  }
  config.packageJsonPath = packageJsonPath;

  return config;
};
