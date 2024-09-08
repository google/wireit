/**
 * @license
 * Copyright 2024 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {DiagnosticWithoutFile, Range, Result} from '../error.js';

export function parseDependency(
  dependency: string,
): Result<ParsedDependency, DiagnosticWithoutFile> {
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

  #done(): boolean {
    return this.#pos >= this.#len;
  }

  #lookAhead(substr: string, offset = 0): boolean {
    return this.#str.includes(substr, this.#pos + offset);
  }

  parse(): Result<ParsedDependency, DiagnosticWithoutFile> {
    const startsWithPeriod = this.#peek() === PERIOD;

    const first = this.#parseParts(startsWithPeriod);
    if (!first.ok) {
      return first;
    }
    if (this.#done()) {
      if (startsWithPeriod) {
        // E.g. "./packages/server:build"
        return {
          ok: true,
          value: {package: first.value, script: []},
        };
      }
      // E.g. "server:build"
      return {
        ok: true,
        value: {package: [], script: first.value},
      };
    }

    // Assume it's either a "#" or a ":".
    this.#skip();
    const second = this.#parseParts();
    if (!second.ok) {
      return second;
    }
    if (!this.#done()) {
      return {
        ok: false,
        error: {
          severity: 'error',
          message:
            `Unexpected ${HASH} delimiter. ` +
            `Maybe you meant to escape it with ${BACKSLASH + HASH}?`,
          location: {range: {offset: this.#pos, length: 1}},
        },
      };
    }
    return {
      ok: true,
      value: {package: first.value, script: second.value},
    };
  }

  #parseParts(isInPathPosition = false): Result<Part[], DiagnosticWithoutFile> {
    let buffer = '';
    const parts: Part[] = [];
    while (!this.#done()) {
      const cur = this.#peek()!;
      if (cur === BACKSLASH && this.#peek(1) === HASH) {
        buffer += HASH;
        this.#skip(2);
      } else if (cur === BACKSLASH && this.#peek(1) === LT) {
        buffer += LT;
        this.#skip(2);
      } else if (cur === LT) {
        if (buffer.length > 0) {
          parts.push({kind: 'literal', value: buffer});
        }
        buffer = '';
        const variable = this.#parseVariable();
        if (!variable.ok) {
          return variable;
        }
        parts.push(variable.value);
      } else if (cur === HASH) {
        break;
      } else if (
        isInPathPosition &&
        cur === COLON &&
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
        buffer += cur;
        this.#skip();
      }
    }
    if (buffer.length > 0) {
      parts.push({kind: 'literal', value: buffer});
    }
    return {ok: true, value: parts};
  }

  #parseVariable(): Result<VariablePart, DiagnosticWithoutFile> {
    const start = this.#pos;
    this.#skip();
    let value = '';
    while (!this.#done()) {
      const cur = this.#peek()!;
      switch (cur) {
        case GT: {
          this.#skip();
          return {ok: true, value: {kind: 'variable', value}};
        }
        case PERIOD:
        case HASH:
        case COLON:
        case BACKSLASH: {
          return {
            ok: false,
            error: {
              severity: 'error',
              message: `The character "${cur}" is not allowed in a variable name.`,
              location: {
                range: {offset: 4, length: 1},
              },
            },
          };
        }
        default: {
          value += cur;
          this.#skip();
        }
      }
    }
    return {
      ok: false,
      error: {
        severity: 'error',
        message:
          'Expected ">" to terminate a variable, but got the end of the string.',
        location: {range: {offset: start, length: this.#pos - start}},
      },
    };
  }
}
