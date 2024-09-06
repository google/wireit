/**
 * @license
 * Copyright 2024 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Diagnostic, Result} from '../error.js';

export function parseDependency(
  dependency: string,
): Result<ParsedDependency, Diagnostic> {
  return new DependencyParser(dependency).parse();
}

export interface ParsedDependency {
  package: string;
  script: string;
}

const PERIOD = '.';
const COLON = ':';
const BACKSLASH = '\\';
const EMPTY = '';

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
      return {ok: true, value: {package: pkg, script}};
    } else {
      const pkg = EMPTY;
      const script = this.#parseScript();
      return {ok: true, value: {package: pkg, script}};
    }
  }

  #parsePackage() {
    let pkg = '';
    while (this.#pos < this.#len) {
      if (this.#peek() === BACKSLASH && this.#peek(1) === COLON) {
        pkg += COLON;
        this.#skip(2);
      } else if (this.#peek() === COLON) {
        break;
      } else {
        pkg += this.#consume();
      }
    }
    return pkg;
  }

  #parseScript() {
    if (this.#peek() === COLON) {
      this.#skip();
    }
    return this.#consume(this.#len - this.#pos);
  }
}
