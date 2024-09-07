/**
 * @license
 * Copyright 2024 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Diagnostic, Range, Result} from '../error.js';

export function parseDependency(
  dependency: string,
): Result<ParsedDependency, Diagnostic> {
  return new DependencyParser(dependency).parse();
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

  #lookAhead(substr: string, offset = 0): boolean {
    return this.#str.includes(substr, this.#pos + offset);
  }

  parse(): Result<ParsedDependency, Diagnostic> {
    const startsWithPeriod = this.#peek() === PERIOD;

    const first = this.#parseParts(startsWithPeriod);
    if (this.#done()) {
      if (startsWithPeriod) {
        return {
          ok: true,
          value: {package: first, script: []},
        };
      }
      return {
        ok: true,
        value: {package: [], script: first},
      };
    }

    // Assume it's either a "#" or a ":".
    this.#skip();
    const second = this.#parseParts();
    if (!this.#done()) {
      return {
        // TODO(aomarks) Error
        ok: true,
        value: {package: [], script: []},
      };
    }
    return {
      ok: true,
      value: {package: first, script: second},
    };
  }

  #parseParts(isInPathPosition = false): Part[] {
    let buffer = '';
    const parts: Part[] = [];
    while (this.#pos < this.#len) {
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
      } else if (this.#peek() === HASH) {
        break;
      } else if (
        isInPathPosition &&
        this.#peek() === COLON &&
        !this.#lookAhead(HASH, 1)
      ) {
        // This case provides backwards compatibility for the syntax before "#"
        // was adopted. The rule here covers cases like:
        //
        //   "./foo:bar"
        //
        // Which we would today recommend writing as:
        //
        //   "./foo#bar"
        //
        // But which, without this case, would be wrongly interpreted as:
        //
        //   { package: undefined , script: "./foo:bar" }
        //
        // Note the reason we switch from ":" to "#" is because of ambiguous
        // cases. Consider the two cases:
        //
        //   1. "build:tsc"
        //   2. "<workspaces>:build"
        //   3. "<this>:build"
        //
        // In case (1), the user clearly meant "the script in this package
        // called build:tsc", but in case (2) they clearly meant "the package
        // called build in all workspaces".
        break;
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
