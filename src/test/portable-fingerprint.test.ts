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
import {portableFingerprintString} from '../util/portable-fingerprint.js';

import type {FingerprintString} from '../fingerprint.js';

const fingerprintJson = (packageDir: string) =>
  JSON.stringify({
    fullyTracked: true,
    platform: 'darwin',
    arch: 'arm64',
    nodeVersion: 'v22.0.0',
    command: 'tsc',
    extraArgs: [],
    clean: true,
    files: {
      [pathlib.join(packageDir, 'src', 'a.ts')]: 'hash-a',
      [pathlib.join(packageDir, 'input.txt')]: 'hash-input',
    },
    output: ['lib/**'],
    dependencies: {
      [scriptReferenceToString({
        packageDir: pathlib.join(packageDir, '..', 'dep'),
        name: 'compile',
      })]: 'dep-hash',
    },
    service: undefined,
    env: {},
  });

void test('portable fingerprint is identical for two absolute checkouts', () => {
  const a = '/tmp/checkout-a/packages/foo';
  const b = '/Users/me/wt/packages/foo';
  const portableA = portableFingerprintString(
    Fingerprint.fromString(fingerprintJson(a) as FingerprintString),
    a,
  );
  const portableB = portableFingerprintString(
    Fingerprint.fromString(fingerprintJson(b) as FingerprintString),
    b,
  );
  assert.equal(portableA, portableB);
  const parsed = JSON.parse(portableA) as {
    files: Record<string, string>;
    dependencies: Record<string, string>;
  };
  assert.deepEqual(
    Object.keys(parsed.files).sort(),
    [pathlib.join('src', 'a.ts'), 'input.txt'].sort(),
  );
  assert.deepEqual(Object.keys(parsed.dependencies), [
    JSON.stringify([pathlib.join('..', 'dep'), 'compile']),
  ]);
});

void test('non-JSON fingerprints pass through for unit-test fakes', () => {
  assert.equal(
    portableFingerprintString(
      Fingerprint.fromString('v0' as FingerprintString),
      '/tmp/pkg',
    ),
    'v0',
  );
});
