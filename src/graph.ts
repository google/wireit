import {ScriptConfig} from './config.js';
import {relative} from 'path';

interface Generator {
  addEdge(from: string, to: string): void;
  done(): void;
}

class GraphViz implements Generator {
  constructor() {
    console.log('digraph {');
  }

  addEdge(from: string, to: string) {
    console.log(`  "${from}" -> "${to}";`);
  }

  done() {
    console.log('}');
  }
}

class Mermaid implements Generator {
  #nextId = 0;
  readonly #labelToId = new Map<string, number>();
  constructor() {
    console.log('graph TD');
  }

  addEdge(from: string, to: string) {
    console.log(`  ${this.#format(from)} --> ${this.#format(to)}`);
  }

  #format(label: string) {
    let id = this.#labelToId.get(label);
    if (id === undefined) {
      id = this.#nextId++;
      this.#labelToId.set(label, id);
      // TODO: properly escape the label
      return `${id}[${label}]`;
    }
    return String(id);
  }

  done() {}
}

export class Graph {
  readonly #config: ScriptConfig;
  readonly #cwd = process.cwd();
  readonly #generator: Generator;
  constructor(config: ScriptConfig, kind: 'mermaid' | 'graphviz' = 'mermaid') {
    this.#config = config;
    if (kind === 'mermaid') {
      this.#generator = new Mermaid();
    } else {
      this.#generator = new GraphViz();
    }
  }

  generate() {
    const seen = new Set<ScriptConfig>();
    const queue = [this.#config];
    let current;
    while ((current = queue.pop())) {
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      for (const dependency of current.dependencies) {
        this.#generator.addEdge(
          this.#formatConfig(current),
          this.#formatConfig(dependency.config)
        );
        queue.push(dependency.config);
      }
    }
    this.#generator.done();
  }

  #formatConfig(config: ScriptConfig) {
    const rel = relative(this.#cwd, config.packageDir);
    if (rel === '') {
      return config.name;
    }
    return `${rel}:${config.name}`;
  }
}
