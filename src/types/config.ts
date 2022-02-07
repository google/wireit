export interface PackageJson {
  wireit?: {[scriptName: string]: Script};
}

export interface Config {
  packageJsonPath: string;
  scripts?: {[scriptName: string]: Script};
}

export interface Script {
  command?: string;
  dependencies?: string[];
  files?: string[];
  output?: string[];
  checkPackageLocks?: boolean;
}
