/**
 * @license
 * Copyright 2024 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Diagnostic, Range, Result} from '../error.js';

export function parseDependency(
  dependency: string,
): Result<ParsedDependency, Diagnostic> {
  if (dependency.includes('#')) {
    return new NewDependencyParser(dependency).parse();
  } else {
    return new DependencyParser(dependency).parse();
  }
}

export interface ParsedDependency {
  package: Part[];
  script: Part[];
  deprecatedColon?: Range;
}

type Part = LiteralPart | VariablePart;

export interface LiteralPart {
  kind: 'literal';
  value: string;
}

export interface VariablePart {
  kind: 'variable';
  value: string;
}

const PERIOD = '.';
const COLON = ':';
const BACKSLASH = '\\';
const LT = '<';
const GT = '>';
const HASH = '#';

class DependencyParser {
  readonly #str: string;
  readonly #len: number;
  #pos = 0;

  constructor(str: string) {
    this.#str = str;
    this.#len = str.length;
  }

  #peek(offset = 0) {
    return this.#str[this.#pos + offset];
  }

  #skip(num = 1) {
    this.#pos += num;
  }

  #consume(num = 1) {
    const substr = this.#str.slice(this.#pos, this.#pos + num);
    this.#pos += num;
    return substr;
  }

  parse(): Result<ParsedDependency, Diagnostic> {
    if (this.#peek() === PERIOD) {
      const pkg = this.#parsePackage();
      const script = this.#parseScript();
      return {
        ok: true,
        value: {package: pkg, script},
      };
    } else {
      if (this.#peek() === BACKSLASH && this.#peek(1) === PERIOD) {
        this.#skip();
      }
      const script = this.#parseScript();
      return {
        ok: true,
        value: {package: [], script},
      };
    }
  }

  #parsePackage(): Part[] {
    let buffer = '';
    const pkg: Part[] = [];
    while (this.#pos < this.#len) {
      if (this.#peek() === BACKSLASH && this.#peek(1) === COLON) {
        buffer += COLON;
        this.#skip(2);
      } else if (this.#peek() === COLON) {
        break;
      } else if (this.#peek() === BACKSLASH && this.#peek(1) === LT) {
        buffer += LT;
        this.#skip(2);
      } else if (this.#peek() === LT) {
        if (buffer.length > 0) {
          pkg.push({kind: 'literal', value: buffer});
        }
        buffer = '';
        pkg.push(this.#parseVariable());
      } else {
        buffer += this.#consume();
      }
    }
    if (buffer.length > 0) {
      pkg.push({kind: 'literal', value: buffer});
    }
    return pkg;
  }

  #parseScript(): Part[] {
    if (this.#peek() === COLON) {
      this.#skip();
    }
    let buffer = '';
    const script: Part[] = [];
    while (this.#pos < this.#len) {
      if (this.#peek() === BACKSLASH && this.#peek(1) === LT) {
        buffer += LT;
        this.#skip(2);
      } else if (this.#peek() === LT) {
        if (buffer.length > 0) {
          script.push({kind: 'literal', value: buffer});
        }
        buffer = '';
        script.push(this.#parseVariable());
      } else {
        buffer += this.#consume();
      }
    }
    if (buffer.length > 0) {
      script.push({kind: 'literal', value: buffer});
    }
    return script;
  }

  #parseVariable(): VariablePart {
    this.#skip();
    let value = '';
    while (this.#pos < this.#len) {
      if (this.#peek() === BACKSLASH && this.#peek(1) === GT) {
        value += GT;
        this.#skip(2);
      } else if (this.#peek() === GT) {
        this.#skip();
        return {kind: 'variable', value};
      } else {
        value += this.#consume();
      }
    }
    return {kind: 'variable', value: 'ERROR'};
  }
}

class NewDependencyParser {
  readonly #str: string;
  readonly #len: number;
  #pos = 0;

  constructor(str: string) {
    this.#str = str;
    this.#len = str.length;
  }

  #peek(offset = 0): string | undefined {
    return this.#str[this.#pos + offset];
  }

  #skip(num = 1): void {
    this.#pos += num;
  }

  #consume(num = 1): string {
    const substr = this.#str.slice(this.#pos, this.#pos + num);
    this.#pos += num;
    return substr;
  }

  #done(): boolean {
    return this.#pos >= this.#len;
  }

  parse(): Result<ParsedDependency, Diagnostic> {
    const packageOrScript = this.#parseParts();
    if (this.#done()) {
      return {
        ok: true,
        value: {package: [], script: packageOrScript},
      };
    }
    if (this.#peek() !== HASH) {
      throw new Error('no!');
    }
    this.#skip(); // Skip the hash
    const script = this.#parseParts();
    if (!this.#done()) {
      throw new Error('NO!');
    }
    return {
      ok: true,
      value: {package: packageOrScript, script},
    };
  }

  #parseParts(): Part[] {
    let buffer = '';
    const parts: Part[] = [];
    while (this.#pos < this.#len) {
      if (this.#peek() === HASH) {
        break;
      }
      if (this.#peek() === BACKSLASH && this.#peek(1) === HASH) {
        buffer += HASH;
        this.#skip(2);
      } else if (this.#peek() === BACKSLASH && this.#peek(1) === LT) {
        buffer += LT;
        this.#skip(2);
      } else if (this.#peek() === LT) {
        if (buffer.length > 0) {
          parts.push({kind: 'literal', value: buffer});
        }
        buffer = '';
        parts.push(this.#parseVariable());
      } else {
        buffer += this.#consume();
      }
    }
    if (buffer.length > 0) {
      parts.push({kind: 'literal', value: buffer});
    }
    return parts;
  }

  #parseVariable(): VariablePart {
    this.#skip();
    let value = '';
    while (this.#pos < this.#len) {
      if (this.#peek() === BACKSLASH && this.#peek(1) === GT) {
        value += GT;
        this.#skip(2);
      } else if (this.#peek() === GT) {
        this.#skip();
        return {kind: 'variable', value};
      } else {
        value += this.#consume();
      }
    }
    return {kind: 'variable', value: 'ERROR'};
  }
}
