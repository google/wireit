import * as fs from 'fs/promises';
import {pkgUp} from 'pkg-up';

import type {Config} from '../types/config.js';

export const readConfig = async (): Promise<{
  config: Config;
  packageJsonPath: string;
}> => {
  const packageJsonPath = await pkgUp();
  if (packageJsonPath === undefined) {
    throw new Error(
      `Could not find a package.json file in ${process.cwd()}` +
        ` or any of its parent directories`
    );
  }

  let packageJsonStr;
  try {
    packageJsonStr = await fs.readFile(packageJsonPath, 'utf8');
  } catch (e) {
    throw new Error(
      `Could not read package.json file ${packageJsonPath}:` +
        ` ${(e as Error).message}`
    );
  }

  let packageJson;
  try {
    packageJson = JSON.parse(packageJsonStr);
  } catch (e) {
    throw new Error(
      `Invalid JSON in package.json ${packageJsonPath}: ` +
        ` ${(e as Error).message}`
    );
  }

  const config = packageJson.wireit as Config;
  if (config === undefined) {
    throw new Error(`No wireit config in package.json ${packageJsonPath}`);
  }

  return {config, packageJsonPath};
};
