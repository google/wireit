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
  CodeAction,
  CodeActionKind,
  WorkspaceEdit,
} from 'vscode-languageserver/node';
import * as jsonParser from 'jsonc-parser';

import {
  Range,
  TextDocument,
  TextEdit,
} from 'vscode-languageserver-textdocument';
import {inspect} from 'util';

const connection = createConnection(ProposedFeatures.all);

interface Modification {
  path: jsonParser.JSONPath;
  value: unknown;
}

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
if (false as boolean) {
  log(`Log is useful when developing, even if we don't use it currently.`);
}

const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

/**
 * A JSON property/value pair in an object literal.
 */
class JsonProperty<T = unknown> {
  readonly key: string;
  readonly value: T;
  readonly keyAst: jsonParser.Node;
  readonly valueAst: jsonParser.Node;
  readonly propertyAst: jsonParser.Node;
  protected constructor(
    key: string,
    value: T,
    keyAst: jsonParser.Node,
    valueAst: jsonParser.Node,
    propertyAst: jsonParser.Node
  ) {
    this.key = key;
    this.value = value;
    this.keyAst = keyAst;
    this.valueAst = valueAst;
    this.propertyAst = propertyAst;
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
      valueAst,
      ast
    );
  }
}

class Analysis {
  #textDocument: TextDocument;

  // The "wireit": {...} object in the package.json file.
  #wireitProperty: JsonProperty | undefined;
  // The "script": {...} object in the package.json file.
  #scriptProperty: JsonProperty | undefined;

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
    this.#wireitProperty?.valueAst?.children?.forEach((child) => {
      const property = JsonProperty.fromAst(child);
      if (property) {
        this.#wireitConfigsByKey.set(property.key, property);
      }
    });
    this.#scriptProperty = scripts;
    this.#scriptProperty?.valueAst?.children?.forEach((child) => {
      const property = JsonProperty.fromAst(child);
      if (property) {
        this.#scriptsByKey.set(property.key, property);
      }
    });
  }

  getDiagnostics(): Diagnostic[] {
    return [
      ...this.#checkThatWireitScriptsDeclaredInScriptsSection(),
      ...this.#checkThatWireitScriptHasAtLeastOneOfCommandOrDependencies(),
    ];
  }

  getCodeActions(range: Range): CodeAction[] {
    const propAndKind = this.#getPropertyByRange(range);
    if (propAndKind == null) {
      return [];
    }
    const {kind, property} = propAndKind;
    if (kind === 'wireit') {
      const scriptProp = this.#scriptsByKey.get(property.key);
      if (scriptProp == null) {
        return [
          {
            kind: CodeActionKind.QuickFix,
            title: 'Add this script to the "scripts" section',
            isPreferred: true,
            edit: this.#modify(['scripts', property.key], 'wireit'),
          },
        ];
      } else if (scriptProp.value !== 'wireit') {
        const wireitCommand = getPropertyByKeyName(
          property.valueAst,
          'command'
        );
        const edits: Modification[] = [
          {path: ['scripts', property.key], value: 'wireit'},
        ];
        if (wireitCommand == null) {
          edits.push({
            path: ['wireit', property.key, 'command'],
            value: scriptProp.value,
          });
        } else if (wireitCommand.value !== scriptProp.value) {
          edits.push({
            path: ['wireit', property.key, '[the script command was]'],
            value: scriptProp.value,
          });
        }
        return [
          {
            kind: CodeActionKind.QuickFix,
            title: 'Update the script to run wireit',
            isPreferred: wireitCommand?.value === scriptProp.value,
            edit: this.#modifyMultiple(edits),
          },
        ];
      }
    } else if (kind === 'script') {
      const wireitProp = this.#wireitConfigsByKey.get(property.key);
      if (wireitProp == null) {
        return [
          {
            kind: CodeActionKind.RefactorExtract,
            title: 'Convert this script to use wireit',
            edit: this.#modifyMultiple([
              {path: ['scripts', property.key], value: 'wireit'},
              {
                path: ['wireit', property.key],
                value: {command: property.value},
              },
            ]),
          },
        ];
      } else if (property.value !== 'wireit') {
        const wireitCommand = getPropertyByKeyName(
          wireitProp.valueAst,
          'command'
        );
        return [
          {
            kind: 'quickfix',
            title: 'Run wireit instead',
            isPreferred: wireitCommand?.value === property.value,
            edit: this.#modify(['scripts', property.key], 'wireit'),
          },
        ];
      }
    } else {
      const never: never = kind;
      throw new Error(`Unexpected kind: ${String(never)}`);
    }
    return [];
  }

  #modifyMultiple(modifications: Array<Modification>): WorkspaceEdit {
    const edits = [];
    for (const {path, value} of modifications) {
      edits.push(
        ...jsonParser.modify(this.#textDocument.getText(), path, value, {
          formattingOptions: {
            tabSize: 2,
            insertSpaces: true,
          },
        })
      );
    }
    const vscodeEdits = edits.map((e): TextEdit => {
      return {
        range: {
          start: this.#textDocument.positionAt(e.offset),
          end: this.#textDocument.positionAt(e.offset + e.length),
        },
        newText: e.content,
      };
    });
    return {
      changes: {
        [this.#textDocument.uri]: vscodeEdits,
      },
    };
  }

  #modify(path: jsonParser.JSONPath, value: unknown): WorkspaceEdit {
    return this.#modifyMultiple([{path, value}]);
  }

  #getPropertyByRange(
    range: Range
  ): {kind: 'wireit' | 'script'; property: JsonProperty} | undefined {
    if (this.#contains(range, this.#wireitProperty?.propertyAst)) {
      // it's inside the wireit range
      for (const prop of this.#wireitConfigsByKey.values()) {
        if (this.#contains(range, prop.propertyAst)) {
          return {kind: 'wireit', property: prop};
        }
      }
    } else if (this.#contains(range, this.#scriptProperty?.propertyAst)) {
      // it's inside the script range
      for (const prop of this.#scriptsByKey.values()) {
        if (this.#contains(range, prop.propertyAst)) {
          return {kind: 'script', property: prop};
        }
      }
    }
    return undefined;
  }

  #contains(range: Range, node: jsonParser.Node | undefined) {
    if (node == null) {
      return false;
    }
    const start = this.#textDocument.offsetAt(range.start);
    const end = this.#textDocument.offsetAt(range.end);
    return node.offset < start && node.offset + node.length > end;
  }

  *#checkThatWireitScriptsDeclaredInScriptsSection(): IterableIterator<Diagnostic> {
    for (const prop of this.#wireitConfigsByKey.values()) {
      const scriptProp = this.#scriptsByKey.get(prop.key);
      if (scriptProp == null) {
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
      } else {
        if (
          typeof scriptProp.value === 'string' &&
          scriptProp.value.trim() !== 'wireit'
        ) {
          yield {
            severity: DiagnosticSeverity.Error,
            message: `This script is declared in the "wireit" section, but that won't have any effect unless this command is just "wireit"`,
            source: 'wireit',
            range: {
              start: this.#textDocument.positionAt(scriptProp.valueAst.offset),
              end: this.#textDocument.positionAt(
                scriptProp.valueAst.offset + scriptProp.valueAst.length
              ),
            },
          };
        }
      }
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

connection.onCodeAction((params) => {
  const document = documents.get(params.textDocument.uri);
  if (document == null) {
    return [];
  }
  const analysis = new Analysis(document);
  return analysis.getCodeActions(params.range);
});

function getPropertyByKeyName(objectNode: jsonParser.Node, key: string) {
  if (objectNode.type !== 'object') {
    return undefined;
  }
  const node = objectNode.children?.find((child) => {
    if (child.type !== 'property') {
      return false;
    }
    const keyNode = child.children?.[0];
    return keyNode?.type === 'string' && keyNode.value === key;
  });
  if (node == null) {
    return undefined;
  }
  return JsonProperty.fromAst(node);
}

// Actually start listening
documents.listen(connection);
connection.listen();
