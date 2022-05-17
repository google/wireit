/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {inspect} from 'util';
import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {drawSquiggle, OffsetToPositionConverter} from '../error.js';
import {IdeAnalyzer} from '../ide.js';
import {WireitTestRig} from './util/test-rig.js';
import * as url from 'url';
import {removeAciiColors} from './util/colors.js';

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

async function assertDefinition(
  ide: IdeAnalyzer,
  options: {
    path: string;
    contentsWithPipe: string;
    expected:
      | undefined
      | {
          target: string;
          targetSelection: string;
          originSelection: string;
        };
  }
) {
  const offset = options.contentsWithPipe.indexOf('|');
  const contents =
    options.contentsWithPipe.slice(0, offset) +
    options.contentsWithPipe.slice(offset + 1);
  ide.setOpenFileContents(options.path, contents);
  const sourceFile = await ide.getPackageJsonForTest(options.path);
  if (sourceFile == null) {
    throw new Error(`could not get source file`);
  }
  const sourceConverter = OffsetToPositionConverter.get(sourceFile.jsonFile);
  const definitions = await ide.getDefinition(
    options.path,
    sourceConverter.toIdePosition(offset)
  );
  if (definitions === undefined) {
    if (options.expected === undefined) {
      return; // No definition, as expected.
    }
    throw new Error(
      `Expected to find a definition matching \n${inspect(options.expected)}`
    );
  }
  // currently we always expect one definition
  assert.equal(definitions.length, 1);
  const definition = definitions[0];
  if (options.expected === undefined) {
    throw new Error(
      `Expected no definition, but got one: ${inspect(definition)}`
    );
  }
  const targetFile = await ide.getPackageJsonForTest(
    url.fileURLToPath(definition.targetUri)
  );
  if (targetFile == null) {
    throw new Error(`Could not load target file`);
  }
  const targetConverter = OffsetToPositionConverter.get(targetFile.jsonFile);
  const targetSquiggle = drawSquiggle(
    {
      file: targetFile.jsonFile,
      range: targetConverter.ideRangeToRange(definition.targetRange),
    },
    0
  );
  assertSquiggleEquals(targetSquiggle, options.expected.target);

  const targetSelectionSquiggle = drawSquiggle(
    {
      file: targetFile.jsonFile,
      range: targetConverter.ideRangeToRange(definition.targetSelectionRange),
    },
    0
  );
  assertSquiggleEquals(
    targetSelectionSquiggle,
    options.expected.targetSelection
  );
  if (definition.originSelectionRange == null) {
    throw new Error(`No iriginSelectionRange returned`);
  }
  const sourceSelectionSquiggle = drawSquiggle(
    {
      file: sourceFile.jsonFile,
      range: sourceConverter.ideRangeToRange(definition.originSelectionRange),
    },
    2
  );
  assertSquiggleEquals(
    sourceSelectionSquiggle,
    options.expected.originSelection
  );
}

function assertSquiggleEquals(actual: string, expected: string) {
  actual = removeAciiColors(actual);
  if (actual.trim() !== expected.trim()) {
    console.log(`Copy pastable output:\n${actual}`);
  }
  assert.equal(actual.trim(), expected.trim());
}

test('we can get the definition for a same file dependency', async ({rig}) => {
  const ide = new IdeAnalyzer();
  await assertDefinition(ide, {
    path: rig.resolve('package.json'),
    contentsWithPipe: JSON.stringify(
      {
        scripts: {
          a: 'wireit',
          b: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['|b'],
          },
          b: {
            command: 'echo',
          },
        },
      },
      null,
      2
    ),
    expected: {
      target: `
    "b": {
    ~~~~~~
      "command": "echo"
~~~~~~~~~~~~~~~~~~~~~~~
    }
~~~~~`,
      targetSelection: `
    "b": {
    ~~~`,
      originSelection: `
          "b"
          ~~~`,
    },
  });
});

test(`we jump to the scripts section for a vanilla script`, async ({rig}) => {
  const ide = new IdeAnalyzer();
  await assertDefinition(ide, {
    path: rig.resolve('package.json'),
    contentsWithPipe: JSON.stringify(
      {
        scripts: {
          a: 'wireit',
          b: 'echo',
        },
        wireit: {
          a: {
            dependencies: ['|b'],
          },
        },
      },
      null,
      2
    ),
    expected: {
      target: `
    "b": "echo"
    ~~~~~~~~~~~`,
      targetSelection: `
    "b": "echo"
    ~~~`,
      originSelection: `
          "b"
          ~~~`,
    },
  });
});

test('jump to definition from object style dependency', async ({rig}) => {
  const ide = new IdeAnalyzer();
  await assertDefinition(ide, {
    path: rig.resolve('package.json'),
    contentsWithPipe: JSON.stringify(
      {
        scripts: {
          a: 'wireit',
          b: 'echo',
        },
        wireit: {
          a: {
            dependencies: [{script: '|b'}],
          },
        },
      },
      null,
      2
    ),
    expected: {
      target: `
    "b": "echo"
    ~~~~~~~~~~~`,
      targetSelection: `
    "b": "echo"
    ~~~`,
      originSelection: `
            "script": "b"
                      ~~~`,
    },
  });
});

test(`we don't get definitions for non-dep locations`, async ({rig}) => {
  const ide = new IdeAnalyzer();
  await assertDefinition(ide, {
    path: rig.resolve('package.json'),
    contentsWithPipe: JSON.stringify(
      {
        scripts: {
          a: 'wireit',
          b: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['b'],
            foo: 'b|ar',
          },
          b: {
            command: 'echo',
          },
        },
      },
      null,
      2
    ),
    expected: undefined,
  });
  await assertDefinition(ide, {
    path: rig.resolve('package.json'),
    contentsWithPipe: JSON.stringify(
      {
        scripts: {
          a: 'wireit',
          b: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['b'],
            foo: 'b|ar',
          },
          b: {
            command: 'echo',
          },
        },
      },
      null,
      2
    ),
    expected: undefined,
  });
  await assertDefinition(ide, {
    path: rig.resolve('package.json'),
    contentsWithPipe: JSON.stringify(
      {
        scripts: {
          a: 'wireit',
          b: 'wireit',
        },
        wireit: {
          a: {
            ['depen|dencies']: ['b'],
          },
          b: {
            command: 'echo',
          },
        },
      },
      null,
      2
    ),
    expected: undefined,
  });
  await assertDefinition(ide, {
    path: rig.resolve('package.json'),
    contentsWithPipe: JSON.stringify(
      {
        scripts: {
          a: 'wireit',
          b: 'wireit',
        },
        wireit: {
          ['|a']: {
            dependencies: ['b'],
          },
          b: {
            command: 'echo',
          },
        },
      },
      null,
      2
    ),
    expected: undefined,
  });
});

test(`we can jump to definitions across files`, async ({rig}) => {
  const ide = new IdeAnalyzer();
  await rig.write('child/package.json', {scripts: {b: 'echo'}});
  await assertDefinition(ide, {
    path: rig.resolve('package.json'),
    contentsWithPipe: JSON.stringify(
      {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['./chil|d:b'],
          },
        },
      },
      null,
      2
    ),
    expected: {
      target: `
    "b": "echo"
    ~~~~~~~~~~~`,
      targetSelection: `
    "b": "echo"
    ~~~`,
      originSelection: `
          "./child:b"
          ~~~~~~~~~~~`,
    },
  });
});

test('can jump from scripts section to wireit config', async ({rig}) => {
  const ide = new IdeAnalyzer();
  await assertDefinition(ide, {
    path: rig.resolve('package.json'),
    contentsWithPipe: JSON.stringify(
      {
        scripts: {
          a: 'wir|eit',
          b: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['b'],
          },
          b: {
            command: 'echo',
          },
        },
      },
      null,
      2
    ),
    expected: {
      target: `
    "a": {
    ~~~~~~
      "dependencies": [
~~~~~~~~~~~~~~~~~~~~~~~
        "b"
~~~~~~~~~~~
      ]
~~~~~~~
    },
~~~~~`,
      targetSelection: `
    "a": {
    ~~~`,
      originSelection: `
      "a": "wireit",
      ~~~~~~~~~~~~~`,
    },
  });
});

test('can jump from colon in scripts section to wireit config', async ({
  rig,
}) => {
  const ide = new IdeAnalyzer();
  await assertDefinition(ide, {
    path: rig.resolve('package.json'),
    contentsWithPipe: `
    {
      "scripts": {
        "a":| "wireit",
        "b": "wireit"
      },
      "wireit": {
        "a": {
          "dependencies": ["b"]
        },
        "b": {
          "command": "echo"
        }
      }
    }`,
    expected: {
      target: `
        "a": {
        ~~~~~~
          "dependencies": ["b"]
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
        },
~~~~~~~~~`,
      targetSelection: `
        "a": {
        ~~~`,
      originSelection: `
          "a": "wireit",
          ~~~~~~~~~~~~~`,
    },
  });
});

test.run();
