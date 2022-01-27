export interface PackageJson {
  wireit?: Config;
}

export interface Config {
  packageJsonPath: string;
  tasks?: {[taskName: string]: Task};
}

export interface Task {
  command?: string;
  dependencies?: string[];
  files?: string[];
  npm?: boolean;
}
