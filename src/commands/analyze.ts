import {readConfig} from '../shared/read-config.js';

import type {Node} from '../types/graph.js';

export default async (_args: string[]) => {
  console.log('analyzing');

  const {config, packageJsonPath} = await readConfig();
  for (const [taskName, {command, dependencies}] of Object.entries(
    config.tasks ?? {}
  )) {
    const node: Node = {
      id: {packageJsonPath, taskName},
      command,
      inputs: [],
      dependencies: [],
    };
    for (const dependencyTaskName of dependencies ?? []) {
      node.dependencies.push({packageJsonPath, taskName: dependencyTaskName});
    }
    console.log(node);
  }
};
