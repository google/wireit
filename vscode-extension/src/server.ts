/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// This is where the bulk of the work of the extension happens. This file
// runs in its own process, and communicates with the main process via
// node IPC.

// jsonc-parser often uses 'any' when they mean 'unknown'. We might want to
// declare our own types for them, but for now, we'll just quiet down eslint.
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

import * as util from 'util';
import {
  createConnection,
  TextDocuments,
  Diagnostic,
  ProposedFeatures,
  DiagnosticSeverity,
  InitializeResult,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node';
import * as jsonParser from 'jsonc-parser';

import {TextDocument} from 'vscode-languageserver-textdocument';

const connection = createConnection(ProposedFeatures.all);

connection.onInitialize(() => {
  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      // If we add any new features, we'll generally need to declare them
      // here.
    },
  };
  return result;
});

const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

/**
 * A JSON property/value pair in an object literal.
 */
class JsonProperty<T = unknown> {
  readonly key: string;
  readonly value: T;
  readonly keyAst: jsonParser.Node;
  readonly valueAst: jsonParser.Node;
  private constructor(
    key: string,
    value: T,
    keyAst: jsonParser.Node,
    valueAst: jsonParser.Node
  ) {
    this.key = key;
    this.value = value;
    this.keyAst = keyAst;
    this.valueAst = valueAst;
  }

  static fromAst(ast: jsonParser.Node): JsonProperty | undefined {
    if (ast.type !== 'property') {
      return undefined;
    }
    const keyAst = ast.children?.[0];
    const valueAst = ast.children?.[1];
    if (keyAst?.type !== 'string' || valueAst == null) {
      return undefined;
    }
    return new JsonProperty(
      keyAst.value as string,
      valueAst.value as unknown,
      keyAst,
      valueAst
    );
  }
}

class Analysis {
  #textDocument: TextDocument;

  // The "wireit": {...} object in the package.json file.
  #wireitProperty: jsonParser.Node | undefined;
  // The "script": {...} object in the package.json file.
  #scriptProperty: jsonParser.Node | undefined;

  #wireitConfigsByKey: Map<string, JsonProperty> = new Map();
  #scriptsByKey: Map<string, JsonProperty> = new Map();

  constructor(textDocument: TextDocument) {
    this.#textDocument = textDocument;
    const [wireit, scripts] = (() => {
      const jsonDocument = jsonParser.parseTree(textDocument.getText());
      if (jsonDocument == null) {
        return [];
      }
      return [
        getPropertyByKeyName(jsonDocument, 'wireit'),
        getPropertyByKeyName(jsonDocument, 'scripts'),
      ];
    })();
    this.#wireitProperty = wireit;
    this.#wireitProperty?.children?.[1]?.children?.forEach((child) => {
      const property = JsonProperty.fromAst(child);
      if (property) {
        this.#wireitConfigsByKey.set(property.key, property);
      }
    });
    this.#scriptProperty = scripts;
    this.#scriptProperty?.children?.[1]?.children?.forEach((child) => {
      const property = JsonProperty.fromAst(child);
      if (property) {
        this.#scriptsByKey.set(property.key, property);
      }
    });
    connection.console.log(util.inspect(this.#wireitConfigsByKey.entries()));
  }

  getDiagnostics(): Diagnostic[] {
    return [
      ...this.#checkThatWireitScriptsDeclaredInScriptsSection(),
      ...this.#checkThatWireitScriptHasAtLeastOneOfCommandOrDependencies(),
    ];
  }

  *#checkThatWireitScriptsDeclaredInScriptsSection(): IterableIterator<Diagnostic> {
    const unclaimedWireitConfigs = new Map([...this.#wireitConfigsByKey]);

    for (const prop of this.#scriptsByKey.values()) {
      const hasWireitConfig = unclaimedWireitConfigs.delete(prop.key);
      if (
        hasWireitConfig &&
        typeof prop.value === 'string' &&
        prop.value.trim() !== 'wireit'
      ) {
        yield {
          severity: DiagnosticSeverity.Error,
          message: `This script is declared in the "wireit" section, but that won't have any effect unless this command is just "wireit"`,
          source: 'wireit',
          range: {
            start: this.#textDocument.positionAt(prop.valueAst.offset),
            end: this.#textDocument.positionAt(
              prop.valueAst.offset + prop.valueAst.length
            ),
          },
        };
      }
    }

    for (const prop of unclaimedWireitConfigs.values()) {
      yield {
        severity: DiagnosticSeverity.Error,
        message: `This script is declared in the "wireit" section, but not in the "scripts" section`,
        source: 'wireit',
        range: {
          start: this.#textDocument.positionAt(prop.keyAst.offset),
          end: this.#textDocument.positionAt(
            prop.keyAst.offset + prop.keyAst.length
          ),
        },
      };
    }
  }

  *#checkThatWireitScriptHasAtLeastOneOfCommandOrDependencies(): IterableIterator<Diagnostic> {
    for (const prop of this.#wireitConfigsByKey.values()) {
      if (prop.valueAst.type !== 'object') {
        continue;
      }
      const command = getPropertyByKeyName(prop.valueAst, 'command');
      const dependencies = getPropertyByKeyName(prop.valueAst, 'dependencies');
      if (command == null && dependencies == null) {
        yield {
          severity: DiagnosticSeverity.Error,
          message: `Set either "command" or "dependencies", otherwise there's nothing for wireit to do.`,
          source: 'wireit',
          range: {
            start: this.#textDocument.positionAt(prop.keyAst.offset),
            end: this.#textDocument.positionAt(
              prop.keyAst.offset + prop.keyAst.length
            ),
          },
        };
      }
    }
  }
}

documents.onDidChangeContent((change) => {
  try {
    const analysis = new Analysis(change.document);
    connection.sendDiagnostics({
      uri: change.document.uri,
      diagnostics: analysis.getDiagnostics(),
    });
  } catch (e) {
    connection.console.log(
      `Error trying to get and send diagnostics: ${String(e)}`
    );
  }
});

function getPropertyByKeyName(objectNode: jsonParser.Node, key: string) {
  if (objectNode.type !== 'object') {
    return undefined;
  }
  return objectNode.children?.find((child) => {
    if (child.type !== 'property') {
      return false;
    }
    const keyNode = child.children?.[0];
    return keyNode?.type === 'string' && keyNode.value === key;
  });
}

// Actually start listening
documents.listen(connection);
connection.listen();
