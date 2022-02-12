import * as fs from 'fs/promises';

import type {PackageJson} from '../types/config.js';

export const readPackageJson = async (
  packageJsonPath: string
): Promise<PackageJson> => {
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

  return packageJson;
};
