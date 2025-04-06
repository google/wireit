/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {test} from 'uvu';
import * as assert from 'uvu/assert';
import {GitHubActionsCache} from '../caching/github-actions-cache.js';
import {Fingerprint, type FingerprintString} from '../fingerprint.js';
import {Console} from '../logging/logger.js';
import {SimpleLogger} from '../logging/simple-logger.js';

test('env vars look like we expect', () => {
  for (const [key, val] of Object.entries(process.env)) {
    if (
      key.startsWith('GITHUB_') ||
      key.startsWith('ACTIONS_') ||
      key.startsWith('WIREIT_')
    ) {
      console.log(`${key}=${val}`);
    }
  }
});

test('can cache something', async () => {
  const cacheResult = await GitHubActionsCache.create(
    new SimpleLogger('.', new Console(process.stderr, process.stderr)),
  );
  assert.ok(cacheResult.ok);
  const cache = cacheResult.value;
  const script = {name: 'test', packageDir: '.'};
  const fingerprint = Fingerprint.fromString(
    `{"random":${Math.random()}}` as FingerprintString,
  );
  const result = await cache.get(script, fingerprint);
  assert.equal(result, undefined);

  //   const setResult = await cache.set(script, fingerprint, [
  //     {
  //       _AbsoluteEntryBrand_: true as never,
  //       name: import.meta.filename,
  //       path: import.meta.filename,
  //       dirent: {
  //         name: import.meta.filename,
  //         isBlockDevice: () => false,
  //         isCharacterDevice: () => false,
  //         isDirectory: () => false,
  //         isFIFO: () => false,
  //         isFile: () => true,
  //         isSocket: () => false,
  //         isSymbolicLink: () => false,
  //       },
  //     },
  //   ]);
});

test.run();
