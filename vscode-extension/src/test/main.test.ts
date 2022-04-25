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
  const ourId = 'todo-register-publisher.wireit-extension';
  assert.ok(
    extensionIds.includes(ourId),
    `Expected ${JSON.stringify(extensionIds)} to include '${ourId}'`
  );
});

// This is mainly a test that the schema is present and automatically
// applies to all package.json files. The contents of the schema are
// tested in the main wireit package.
test('warns on a package.json with a bad wireit config', async () => {
  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.file(
      pathlib.join(__dirname, '../../src/test/fixtures/incorrect/package.json')
    )
  );
  await vscode.window.showTextDocument(doc);

  // wait until the JSON language server is ready and diagnostics are produced
  async function getDiagnostics() {
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

  const diagnostics = await getDiagnostics();
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
        start: {line: 3, character: 17},
        end: {line: 3, character: 18},
      },
    ]
  );
});

export {test};
