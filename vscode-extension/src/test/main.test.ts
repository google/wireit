/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import * as pathlib from 'path';

import {test} from 'uvu';
import * as assert from 'uvu/assert';

test('the extension is installed', () => {
  const extensionIds = vscode.extensions.all.map((extension) => extension.id);
  const ourId = 'google.wireit';
  assert.ok(
    extensionIds.includes(ourId),
    `Expected ${JSON.stringify(extensionIds)} to include '${ourId}'`
  );
});

// Wait until the something is able to produce diagnostics, then return
// those.
async function getDiagnostics(
  doc: vscode.TextDocument
): Promise<vscode.Diagnostic[]> {
  for (let i = 0; i < 1000; i++) {
    const diagnostics = vscode.languages.getDiagnostics(doc.uri);
    if (diagnostics.length > 0) {
      return diagnostics;
    }
    // Is there a better way to wait for the server to be ready?
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('No diagnostics found');
}

// This is mainly a test that the schema is present and automatically
// applies to all package.json files. The contents of the schema are
// tested in the main wireit package.
test('warns on a package.json based on the schema', async () => {
  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.file(
      pathlib.join(__dirname, '../../src/test/fixtures/incorrect/package.json')
    )
  );
  await vscode.window.showTextDocument(doc);
  const diagnostics = await getDiagnostics(doc);
  assert.equal(
    diagnostics.map((d) => d.message),
    [`Incorrect type. Expected "string".`]
  );
  assert.equal(
    diagnostics.map((d) => ({
      start: {line: d.range.start.line, character: d.range.start.character},
      end: {line: d.range.end.line, character: d.range.end.character},
    })),
    [
      {
        start: {line: 6, character: 17},
        end: {line: 6, character: 18},
      },
    ]
  );
});

test('warns on a package.json based on semantic analysis in the language server', async () => {
  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.file(
      pathlib.join(
        __dirname,
        '../../src/test/fixtures/semantic_errors/package.json'
      )
    )
  );
  await vscode.window.showTextDocument(doc);
  const diagnostics = await getDiagnostics(doc);
  assert.equal(
    diagnostics.map((d) => d.message),
    [
      `This script is declared in the "wireit" section, but that won't have any effect unless this command is just "wireit"`,
      `This script is declared in the "wireit" section, but not in the "scripts" section`,
      'Set either "command" or "dependencies", otherwise there\'s nothing for wireit to do.',
    ],
    JSON.stringify(diagnostics.map((d) => d.message))
  );
  assert.equal(
    diagnostics.map((d) => ({
      start: {line: d.range.start.line, character: d.range.start.character},
      end: {line: d.range.end.line, character: d.range.end.character},
    })),
    [
      {start: {line: 2, character: 26}, end: {line: 2, character: 31}},
      {start: {line: 11, character: 4}, end: {line: 11, character: 20}},
      {start: {line: 17, character: 4}, end: {line: 17, character: 38}},
    ],
    JSON.stringify(
      diagnostics.map((d) => ({
        start: {line: d.range.start.line, character: d.range.start.character},
        end: {line: d.range.end.line, character: d.range.end.character},
      }))
    )
  );
});

export {test};
