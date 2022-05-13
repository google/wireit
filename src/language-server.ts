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
  ProposedFeatures,
  InitializeResult,
  TextDocumentSyncKind,
  CodeActionKind,
} from 'vscode-languageserver/node';
import * as url from 'url';

import {TextDocument} from 'vscode-languageserver-textdocument';
import {inspect} from 'util';
import {IdeAnalyzer} from './ide.js';

const ideAnalyzer = new IdeAnalyzer();
const connection = createConnection(ProposedFeatures.all);

connection.onInitialize(() => {
  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      // If we add any new features, we'll generally need to declare them
      // here.
      codeActionProvider: {
        codeActionKinds: [
          CodeActionKind.QuickFix,
          CodeActionKind.RefactorExtract,
        ],
      },
      definitionProvider: true,
    },
  };
  return result;
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function log(...values: unknown[]) {
  for (const value of values) {
    let message;
    if (typeof value === 'string') {
      message = value;
    } else {
      message = inspect(value);
    }
    connection.console.log(message);
  }
}

// So that we can just console.log and console.error as usual.
console.log = log;
console.error = log;

const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let requestIdCounter = 0;
const getAndSendDiagnostics = async () => {
  requestIdCounter++;
  const requestId = requestIdCounter;
  const diagnosticsByFile = await ideAnalyzer.getDiagnostics();
  if (requestId !== requestIdCounter) {
    return; // another request has been made since this one
  }
  for (const path of ideAnalyzer.openFiles) {
    const diagnostics = diagnosticsByFile.get(path) ?? [];
    void connection.sendDiagnostics({
      uri: url.pathToFileURL(path).toString(),
      diagnostics: [...diagnostics],
    });
  }
};

const updateOpenFile = (document: TextDocument) => {
  if (document.languageId !== 'json') {
    return;
  }
  const path = url.fileURLToPath(document.uri);
  if (!path.endsWith('package.json')) {
    return;
  }
  const contents = document.getText();
  ideAnalyzer.setOpenFileContents(path, contents);
  void getAndSendDiagnostics();
};

documents.onDidOpen((event) => {
  updateOpenFile(event.document);
});

documents.onDidChangeContent((change) => {
  updateOpenFile(change.document);
});

documents.onDidClose((change) => {
  const path = url.fileURLToPath(change.document.uri);
  ideAnalyzer.closeFile(path);
  void getAndSendDiagnostics();
  // Clear diagnostics for closed file.
  void connection.sendDiagnostics({
    uri: change.document.uri,
    diagnostics: [],
  });
});

connection.onCodeAction(async (params) => {
  const document = documents.get(params.textDocument.uri);
  if (document == null) {
    return [];
  }
  const path = url.fileURLToPath(document.uri);
  const actions = await ideAnalyzer.getCodeActions(path, params.range);
  return actions;
});

connection.onDefinition(async (params) => {
  const path = url.fileURLToPath(params.textDocument.uri);
  const position = params.position;
  return ideAnalyzer.getDefinition(path, position);
});

// Actually start listening
documents.listen(connection);
connection.listen();
