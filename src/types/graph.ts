export interface NodeReference {
  packageJsonPath: string;
  taskName: string;
}

export interface Node {
  id: NodeReference;
  command?: string;
  dependencies: NodeReference[];
  inputs: string[];
}
