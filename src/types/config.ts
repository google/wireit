export interface PackageJson {
  wireit?: {[taskName: string]: Task};
}

export interface Config {
  packageJsonPath: string;
  tasks?: {[taskName: string]: Task};
}

export interface Task {
  command?: string;
  dependencies?: string[];
  files?: string[];
  outputs?: string[];
  npm?: boolean;
}
