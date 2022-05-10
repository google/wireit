/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FileSystem} from './util/package-json-reader.js';
import * as fs from 'fs/promises';
import {Analyzer} from './analyzer.js';
import {Diagnostic, OffsetToPositionConverter} from './error.js';
import * as url from 'url';

import type {
  Diagnostic as IdeDiagnostic,
  DiagnosticSeverity,
  DiagnosticRelatedInformation,
} from 'vscode-languageclient';

class OverlayFilesystem implements FileSystem {
  // filename to contents
  readonly overlay = new Map<string, string>();

  async readFile(path: string, options: 'utf8'): Promise<string> {
    const contents = this.overlay.get(path);
    if (contents !== undefined) {
      return contents;
    }
    return fs.readFile(path, options);
  }
}

/**
 * The interface for an IDE to communicate with wireit's analysis pipeline.
 *
 * An IDE has certain files open with in-memory buffers. These buffers often
 * shadow the files on disk, and in those cases we want to use the buffer if
 * it's available, and fall back on disk contents if not.
 *
 * Generally the user only cares about the in-memory files, at least for
 * most features like diagnostics.
 */
export class IdeAnalyzer {
  readonly #overlayFs;
  #analyzer;
  constructor() {
    this.#overlayFs = new OverlayFilesystem();
    this.#analyzer = new Analyzer(this.#overlayFs);
  }

  /**
   * Adds the file to the set of open files if it wasn't already,
   * and specifies its contents. Open files are defined by their
   * in memory contents, not by their on-disk contents.
   *
   * We also only care about diagnostics for open files.
   *
   * IDEs will typically call this method when a user opens a package.json file
   * for editing, as well as once for each edit the user makes.
   */
  setOpenFileContents(path: string, contents: string): void {
    this.#overlayFs.overlay.set(path, contents);
    this.#analyzer = new Analyzer(this.#overlayFs);
  }

  /**
   * Removes a file from the set of open files.
   */
  closeFile(path: string): void {
    this.#overlayFs.overlay.delete(path);
    this.#analyzer = new Analyzer(this.#overlayFs);
  }

  get openFiles(): Iterable<string> {
    return this.#overlayFs.overlay.keys();
  }

  /**
   * Calculates and returns diagnostics for open files. If a file has no
   * diagnostics then we don't include an entry for it at all.
   */
  async getDiagnostics(): Promise<Map<string, Set<IdeDiagnostic>>> {
    const diagnostics = new Map<string, Set<IdeDiagnostic>>();
    function addDiagnostic(diagnostic: Diagnostic) {
      const path = diagnostic.location.file.path;
      if (!openFiles.has(path)) {
        return;
      }
      const converted = convertDiagnostic(diagnostic);
      let set = diagnostics.get(path);
      if (set === undefined) {
        set = new Set();
        diagnostics.set(path, set);
      }
      set.add(converted);
    }

    const openFiles = new Set(this.openFiles);
    for (const failure of await this.#analyzer.analyzeFiles([...openFiles])) {
      if (failure.diagnostic != null) {
        addDiagnostic(failure.diagnostic);
      }
      if (failure.diagnostics != null) {
        for (const diagnostic of failure.diagnostics) {
          addDiagnostic(diagnostic);
        }
      }
    }
    return diagnostics;
  }
}

function convertDiagnostic(d: Diagnostic): IdeDiagnostic {
  const converter = OffsetToPositionConverter.get(d.location.file);
  let relatedInformation: DiagnosticRelatedInformation[] | undefined;
  if (d.supplementalLocations) {
    relatedInformation = [];
    for (const loc of d.supplementalLocations) {
      relatedInformation.push({
        location: {
          uri: url.pathToFileURL(loc.location.file.path).toString(),
          range: converter.toIdeRange(loc.location.range),
        },
        message: loc.message,
      });
    }
  }
  return {
    severity: convertSeverity(d.severity),
    message: d.message,
    source: 'wireit',
    range: converter.toIdeRange(d.location.range),
    relatedInformation,
  };
}

function convertSeverity(
  severity: 'error' | 'warning' | 'info'
): DiagnosticSeverity {
  switch (severity) {
    case 'error':
      return 1; // DiagnosticSeverity.Error;
    case 'warning':
      return 2; // DiagnosticSeverity.Warning;
    case 'info':
      return 3; // DiagnosticSeverity.Information;
    default: {
      const never: never = severity;
      throw new Error(`Unexpected severity: ${String(never)}`);
    }
  }
}
