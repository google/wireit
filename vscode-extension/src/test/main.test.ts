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
  return await tryUntil(() => {
    const diagnostics = vscode.languages.getDiagnostics(doc.uri);
    if (diagnostics.length > 0) {
      return diagnostics;
    }
  });
}

const TICKS_TO_WAIT = process.env.CI ? 1000 : 40;
async function tryUntil<T>(
  f: () => T | null | undefined | Promise<T | null | undefined>
): Promise<T> {
  for (let i = 0; i < TICKS_TO_WAIT; i++) {
    const v = await f();
    if (v != null) {
      return v;
    }
    // Is there a better way to wait for the server to be ready?
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('tryUntil never got a value');
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
  const diagnostic = await tryUntil(() => {
    return vscode.languages.getDiagnostics(doc.uri)?.find((d) => {
      if (`Incorrect type. Expected "string".` === d.message) {
        return d;
      }
    });
  });
  assert.equal(diagnostic.message, `Incorrect type. Expected "string".`);
  const range = diagnostic.range;
  assert.equal(
    {
      start: {line: range.start.line, character: range.start.character},
      end: {line: range.end.line, character: range.end.character},
    },
    {
      start: {line: 6, character: 17},
      end: {line: 6, character: 18},
    },
    JSON.stringify(range)
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
      'This command should just be "wireit", as this script is configured in the wireit section.',
      'A wireit config must set at least one of "command", "dependencies", or "files". Otherwise there is nothing for wireit to do.',
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
