/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomBytes} from 'node:crypto';
import {test} from 'uvu';
import * as assert from 'uvu/assert';
import {GitHubActionsCache} from '../caching/github-actions-cache.js';
import {Fingerprint, type FingerprintString} from '../fingerprint.js';
import {Console} from '../logging/logger.js';
import {SimpleLogger} from '../logging/simple-logger.js';
import {rigTest} from './util/rig-test.js';

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

test(
  'can cache something',
  rigTest(async ({rig}) => {
    const cacheResult = await GitHubActionsCache.create(
      new SimpleLogger('.', new Console(process.stderr, process.stderr)),
    );
    assert.ok(cacheResult.ok);
    const cache = cacheResult.value;

    const script = {name: 'test', packageDir: rig.temp};
    const fingerprint = Fingerprint.fromString(
      // Note this isn't actually a valid fingerprint JSON string, but it
      // doesn't matter, it is hashed without validation.
      `{"test":${Math.random()}}` as FingerprintString,
    );

    const get1 = await cache.get(script, fingerprint);
    assert.is(get1, undefined);

    const filename = 'test';
    const content = randomBytes(200 * 1024 ** 2);
    await rig.write(filename, content);
    const set1 = await cache.set(script, fingerprint, [
      {
        _AbsoluteEntryBrand_: true as never,
        name: filename,
        path: rig.resolve(filename),
        dirent: {
          name: filename,
          isBlockDevice: () => false,
          isCharacterDevice: () => false,
          isDirectory: () => false,
          isFIFO: () => false,
          isFile: () => true,
          isSocket: () => false,
          isSymbolicLink: () => false,
        },
      },
    ]);
    assert.is(set1, true);

    const get2 = await cache.get(script, fingerprint);
    assert.ok(get2);

    await rig.delete(filename);
    assert.not(await rig.exists('test'));
    await get2.apply();
    assert.ok(await rig.exists('test'));
    const actual = await rig.readBytes('test');
    console.log({actual});
    assert.equal(actual, content);

    // TODO(aomarks) Test >100MB file because that will require some different
    // Azure upload code.
  }),
);

test.run();
