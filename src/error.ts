/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Failure} from './event.js';
import {JsonFile} from './util/package-json-reader.js';
import * as pathlib from 'path';

export type Result<T, E = Failure> =
  | {ok: true; value: T}
  | {ok: false; error: E};

export interface Range {
  readonly offset: number;
  readonly length: number;
}

export interface Location {
  readonly file: JsonFile;
  readonly range: Range;
}

export interface MessageLocation {
  readonly message: string;
  readonly location: Location;
}

export interface Diagnostic {
  readonly severity: string;
  readonly message: string;
  readonly location: Location;
  readonly supplementalLocations?: MessageLocation[];
}

export class DiagnosticPrinter {
  #cwd: string;
  #offsetConverterCache = new WeakMap<JsonFile, OffsetToPositionConverter>();

  /**
   * @param workingDir Paths are printed relative to this directory.
   */
  constructor(workingDir: string) {
    this.#cwd = workingDir;
  }

  print(diagnostic: Diagnostic) {
    const path = this.#formatPath(diagnostic.location);
    let result = `❌ ${path} ${diagnostic.message}
${drawSquiggle(diagnostic.location, 4)}`;
    if (diagnostic.supplementalLocations) {
      for (const supplementalLocation of diagnostic.supplementalLocations) {
        result += '\n\n' + this.#printSupplemental(supplementalLocation);
      }
    }
    return result;
  }

  #printSupplemental(supplemental: MessageLocation) {
    const squiggle = drawSquiggle(supplemental.location, 8);
    const path = this.#formatPath(supplemental.location);
    return `    ${path} ${supplemental.message}\n${squiggle}`;
  }

  #formatPath(location: Location) {
    const relPath = pathlib.relative(this.#cwd, location.file.path);
    const {line, column} = this.#offsetToPosition(
      location.file,
      location.range.offset
    );
    return `${CYAN}${relPath}${RESET}:${YELLOW}${line}${RESET}:${YELLOW}${column}${RESET}`;
  }

  #offsetToPosition(
    file: JsonFile,
    offset: number
  ): {line: number; column: number} {
    const indexes = this.#getNewlineIndexes(file);
    return indexes.toPosition(offset);
  }

  #getNewlineIndexes(file: JsonFile): OffsetToPositionConverter {
    let converter = this.#offsetConverterCache.get(file);
    if (converter === undefined) {
      converter = new OffsetToPositionConverter(file.contents);
      this.#offsetConverterCache.set(file, converter);
    }
    return converter;
  }
}

export interface Position {
  /** 1 indexed */
  line: number;
  /** 1 indexed */
  column: number;
}

export class OffsetToPositionConverter {
  readonly newlineIndexes: readonly number[];

  constructor(contents: string) {
    const indexes = [];
    for (let i = 0; i < contents.length; i++) {
      if (contents[i] === '\n') {
        indexes.push(i);
      }
    }
    this.newlineIndexes = indexes;
  }

  toPosition(offset: number): {line: number; column: number} {
    if (this.newlineIndexes.length === 0) {
      return {line: 1, column: offset + 1};
    }
    const line = this.newlineIndexes.findIndex((index) => index >= offset);
    if (line === 0) {
      return {line: 1, column: offset + 1};
    }
    if (line === -1) {
      return {
        line: this.newlineIndexes.length + 1,
        column: offset - this.newlineIndexes[this.newlineIndexes.length - 1],
      };
    }
    return {line: line + 1, column: offset - this.newlineIndexes[line - 1]};
  }
}

const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

// Exported for testing
export function drawSquiggle(location: Location, indent: number): string {
  let {
    range: {offset, length},
  } = location;
  const fileContents = location.file.contents;
  const startOfInitialLine =
    fileContents.slice(0, offset).lastIndexOf('\n') + 1;
  const uncorrectedFirstNewlineIndexAfter = fileContents
    .slice(offset + length)
    .indexOf('\n');
  const endOfLastLine =
    uncorrectedFirstNewlineIndexAfter === -1
      ? undefined
      : offset + length + uncorrectedFirstNewlineIndexAfter;
  offset = offset - startOfInitialLine;

  const sectionToPrint = fileContents.slice(startOfInitialLine, endOfLastLine);
  let result = '';
  for (const line of sectionToPrint.split('\n')) {
    result += `${' '.repeat(indent)}${line}\n`;
    const squiggleLength = Math.min(line.length - offset, length);
    result +=
      ' '.repeat(offset + indent) +
      `${RED}${'~'.repeat(squiggleLength)}${RESET}\n`;
    offset = 0;
    length -= squiggleLength + 1; // +1 to account for the newline
  }
  // Drop the last newline.
  return result.slice(0, -1);
}
