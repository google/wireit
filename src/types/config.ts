export interface Config {
  tasks?: {[taskName: string]: Task};
}

export interface Task {
  command?: string;
  dependencies?: string[];
}
