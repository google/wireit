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

import {Position, TextDocument} from 'vscode-languageserver-textdocument';

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

documents.onDidChangeContent((change) => {
  getDiagnostics(change.document)
    .then((diagnostics) => {
      // Send the computed diagnostics to VSCode.
      connection.sendDiagnostics({uri: change.document.uri, diagnostics});
    })
    .catch((err) => {
      connection.console.error(String(err));
    });
});

interface OffsetConverter {
  positionAt: (offset: number) => Position;
}

// eslint-disable-next-line @typescript-eslint/require-await
async function getDiagnostics(
  textDocument: TextDocument
): Promise<Diagnostic[]> {
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

  const diagnostics: Diagnostic[] = [];
  if (wireit == null || scripts == null) {
    return diagnostics;
  }

  diagnostics.push(
    ...checkThatWireitScriptsDeclaredInScriptsSection(
      wireit,
      scripts,
      textDocument
    )
  );

  diagnostics.push(
    ...checkThatWireitScriptHasAtLeastOneOfCommandOrDependencies(
      wireit,
      textDocument
    )
  );

  return diagnostics;
}

function* checkThatWireitScriptsDeclaredInScriptsSection(
  wireit: jsonParser.Node,
  scripts: jsonParser.Node,
  offsetConverter: OffsetConverter
): IterableIterator<Diagnostic> {
  const wireitKeys = new Map<string, jsonParser.Node>();
  for (const child of wireit.children?.[1]?.children ?? []) {
    if (child.type !== 'property') {
      continue;
    }
    const [key, value] = child.children ?? [];
    if (key == null || value == null || key.type !== 'string') {
      continue;
    }
    const keyValue: string = key.value;
    wireitKeys.set(keyValue, key);
  }

  for (const child of scripts.children?.[1]?.children ?? []) {
    if (child.type !== 'property') {
      continue;
    }
    const [key, value] = child.children ?? [];
    if (value == null || key?.type !== 'string') {
      continue;
    }
    const keyValue = key.value;
    const wireitKey = wireitKeys.get(keyValue);
    if (wireitKey == null) {
      continue;
    }
    wireitKeys.delete(key.value);
    if (
      value.type !== 'string' ||
      (value.value as string).trim() !== 'wireit'
    ) {
      yield {
        severity: DiagnosticSeverity.Error,
        message:
          "This script is declared in the 'wireit' section, but that won't have any effect this command is just \"wireit\"",
        source: 'wireit',
        range: {
          start: offsetConverter.positionAt(value.offset),
          end: offsetConverter.positionAt(value.offset + value.length),
        },
      };
    }
  }

  for (const wireitKey of wireitKeys.values()) {
    yield {
      severity: DiagnosticSeverity.Error,
      message: `This script is declared in the 'wireit' section, but not in the 'scripts' section`,
      source: 'wireit',
      range: {
        start: offsetConverter.positionAt(wireitKey.offset),
        end: offsetConverter.positionAt(wireitKey.offset + wireitKey.length),
      },
    };
  }
}

function* checkThatWireitScriptHasAtLeastOneOfCommandOrDependencies(
  wireit: jsonParser.Node,
  offsetConverter: OffsetConverter
): IterableIterator<Diagnostic> {
  for (const child of wireit.children?.[1]?.children ?? []) {
    if (child.type !== 'property') {
      continue;
    }
    const [key, value] = child.children ?? [];
    if (key?.type !== 'string' || value?.type !== 'object') {
      continue;
    }
    const command = getPropertyByKeyName(value, 'command');
    const dependencies = getPropertyByKeyName(value, 'dependencies');
    if (command == null && dependencies == null) {
      yield {
        severity: DiagnosticSeverity.Error,
        message: `Set either "command" or "dependencies", otherwise there's nothing for wireit to do.`,
        source: 'wireit',
        range: {
          start: offsetConverter.positionAt(key.offset),
          end: offsetConverter.positionAt(key.offset + key.length),
        },
      };
    }
  }
}

function getPropertyByKeyName(objectNode: jsonParser.Node, key: string) {
  if (objectNode.type !== 'object') {
    return null;
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
