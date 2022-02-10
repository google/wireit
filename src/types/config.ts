export interface PackageJson {
  scripts?: {[scriptName: string]: string};
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
  deleteOutputBeforeEachRun?: boolean;
}
