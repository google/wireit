/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {IdeAnalyzer} from '../ide.js';
import {WireitTestRig} from './util/test-rig.js';

const test = suite<{rig: WireitTestRig}>();

test.before.each(async (ctx) => {
  try {
    ctx.rig = new WireitTestRig();
    await ctx.rig.setup();
  } catch (error) {
    // Uvu has a bug where it silently ignores failures in before and after,
    // see https://github.com/lukeed/uvu/issues/191.
    console.error('uvu before error', error);
    process.exit(1);
  }
});

test.after.each(async (ctx) => {
  try {
    await ctx.rig.cleanup();
  } catch (error) {
    // Uvu has a bug where it silently ignores failures in before and after,
    // see https://github.com/lukeed/uvu/issues/191.
    console.error('uvu after error', error);
    process.exit(1);
  }
});

async function assertDiagnostics(
  ide: IdeAnalyzer,
  expected: Record<string, string[]>
) {
  const actual = {} as Record<string, string[]>;
  const byFile = await ide.getDiagnostics();
  for (const [path, diagnostics] of byFile.entries()) {
    actual[path] = [...diagnostics].map((d) => d.message);
  }
  assert.equal(actual, expected);
}

test('can get diagnostics from a single file', async ({rig}) => {
  const ide = new IdeAnalyzer();
  ide.setOpenFileContents(rig.resolve('package.json'), `{"scripts": "bad"}`);
  await assertDiagnostics(ide, {
    [rig.resolve(`package.json`)]: ['Expected an object, but was string.'],
  });
});

test('changing a file gives us new diagnostics', async ({rig}) => {
  const ide = new IdeAnalyzer();
  ide.setOpenFileContents(rig.resolve(`package.json`), `{"scripts": "bad"}`);
  await assertDiagnostics(ide, {
    [rig.resolve(`package.json`)]: ['Expected an object, but was string.'],
  });
  ide.setOpenFileContents(rig.resolve(`package.json`), `{"scripts": {}}`);
  await assertDiagnostics(ide, {});
  ide.setOpenFileContents(
    rig.resolve(`package.json`),
    `{"scripts": {"bad": []}}`
  );
  await assertDiagnostics(ide, {
    [rig.resolve(`package.json`)]: ['Expected a string, but was array.'],
  });
});

test('the overlay filesystem overrides the regular one', async ({rig}) => {
  await rig.write('child/package.json', {scripts: {}});
  const ide = new IdeAnalyzer();
  ide.setOpenFileContents(
    rig.resolve(`package.json`),
    JSON.stringify({
      scripts: {a: 'wireit'},
      wireit: {
        a: {
          dependencies: ['./child:b'],
        },
      },
    })
  );
  await assertDiagnostics(ide, {
    [rig.resolve(`package.json`)]: [
      `Cannot find script named "b" in package "${rig.resolve('child')}"`,
    ],
  });
  const childPath = rig.resolve('child/package.json');
  ide.setOpenFileContents(
    childPath,
    JSON.stringify({
      scripts: {b: 'foo'},
    })
  );
  assert.equal(
    [...ide.openFiles],
    [rig.resolve('package.json'), rig.resolve('child/package.json')]
  );
  await assertDiagnostics(ide, {});
  // Replace the in-memory buffer with a file on disk.
  await rig.write('child/package.json', {scripts: {c: 'foo'}});
  ide.closeFile(rig.resolve('child/package.json'));
  // We now read the file on disk, but it doesn't have a 'b' diagnostic, just a 'c'.
  await assertDiagnostics(ide, {
    [rig.resolve('package.json')]: [
      `Cannot find script named "b" in package "${rig.resolve('child')}"`,
    ],
  });
  // Updating our main file to point to 'c' should resolve the diagnostic.
  ide.setOpenFileContents(
    rig.resolve('package.json'),
    JSON.stringify({
      scripts: {a: 'wireit'},
      wireit: {
        a: {
          dependencies: ['./child:c'],
        },
      },
    })
  );
  await assertDiagnostics(ide, {});
});

test('we can get cyclic dependency errors', async ({rig}) => {
  const ide = new IdeAnalyzer();
  ide.setOpenFileContents(
    rig.resolve('package.json'),
    JSON.stringify({
      scripts: {
        a: 'wireit',
        b: 'wireit',
      },
      wireit: {
        a: {
          dependencies: ['b'],
        },
        b: {
          dependencies: ['a'],
        },
      },
    })
  );
  await assertDiagnostics(ide, {
    [rig.resolve('package.json')]: [`Cycle detected in dependencies of "a".`],
  });
});

test.run();
