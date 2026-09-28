/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {test} from 'node:test';
import * as assert from 'node:assert';
import * as pathlib from 'path';
import {Fingerprint} from '../fingerprint.js';
import {scriptReferenceToString} from '../config.js';
import {FilesystemTestRig} from './util/filesystem-test-rig.js';

import type {ArrayNode, JsonAstNode} from '../util/ast.js';
import type {Dependency, StandardScriptConfig} from '../config.js';
import type {FingerprintString} from '../fingerprint.js';

const stringNode = (value: string): JsonAstNode<string> => ({
  type: 'string',
  offset: 0,
  length: value.length,
  value,
});

const arrayNode = (values: string[]): ArrayNode<string> => ({
  node: {type: 'array', offset: 0, length: 0, value: undefined},
  values,
});

const scriptAt = (packageDir: string): StandardScriptConfig => ({
  packageDir,
  name: 'compile',
  state: 'valid',
  command: stringNode('tsc'),
  extraArgs: [],
  clean: true,
  files: arrayNode(['src/a.ts', 'input.txt']),
  output: arrayNode(['lib/**']),
  service: undefined,
  env: {},
  dependencies: [],
  services: [],
  scriptAstNode: undefined,
  configAstNode: undefined,
  declaringFile: {
    path: pathlib.join(packageDir, 'package.json'),
    contents: '{}',
  },
  failures: [],
});

const depAt = (
  packageDir: string,
  fingerprint: Fingerprint,
): [Dependency, Fingerprint] => [
  {
    cascade: true,
    config: scriptAt(packageDir),
    specifier: stringNode('compile'),
  },
  fingerprint,
];

void test('fingerprint stays absolute; shared cache entry name matches', async () => {
  await using rig = await FilesystemTestRig.setup();
  await rig.write({
    'a/packages/foo/src/a.ts': 'export const a = 1;',
    'a/packages/foo/input.txt': 'v0',
    'b/packages/foo/src/a.ts': 'export const a = 1;',
    'b/packages/foo/input.txt': 'v0',
  });
  const depFingerprint = Fingerprint.fromString(
    '{"fullyTracked":true}' as FingerprintString,
  );
  const fooA = rig.resolve('a/packages/foo');
  const fooB = rig.resolve('b/packages/foo');
  const resultA = await Fingerprint.compute(scriptAt(fooA), [
    depAt(rig.resolve('a/packages/dep'), depFingerprint),
  ]);
  const resultB = await Fingerprint.compute(scriptAt(fooB), [
    depAt(rig.resolve('b/packages/dep'), depFingerprint),
  ]);
  assert.ok(resultA.ok);
  assert.ok(resultB.ok);
  assert.notEqual(resultA.value.string, resultB.value.string);
  assert.deepEqual(
    Object.keys(resultA.value.data.files).sort(),
    [pathlib.join(fooA, 'src', 'a.ts'), pathlib.join(fooA, 'input.txt')].sort(),
  );
  assert.deepEqual(Object.keys(resultA.value.data.dependencies), [
    scriptReferenceToString({
      packageDir: rig.resolve('a/packages/dep'),
      name: 'compile',
    }),
  ]);
  assert.equal(resultA.value.localCacheEntryName(false), resultA.value.hash);
  assert.notEqual(
    resultA.value.localCacheEntryName(false),
    resultB.value.localCacheEntryName(false),
  );
  assert.equal(
    resultA.value.localCacheEntryName(true),
    resultB.value.localCacheEntryName(true),
  );
});
