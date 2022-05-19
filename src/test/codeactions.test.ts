/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {IdeAnalyzer} from '../ide.js';
import {WireitTestRig} from './util/test-rig.js';
import type {CodeAction} from 'vscode-languageclient';
import * as jsonParser from 'jsonc-parser';
import {OffsetToPositionConverter} from '../error.js';

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

/**
 * Get the code actions that would be offered for the given contents.
 *
 * The location is given by including a '|' character at the caret position.
 * The pipe character is removed and isn't a part of the contents that the
 * parser or the rest of the test sees.
 */
async function getCodeActions(options: {
  rig: WireitTestRig;
  contentsWithPipe: string | object;
}) {
  const contentsWithPipe =
    typeof options.contentsWithPipe === 'string'
      ? options.contentsWithPipe
      : JSON.stringify(options.contentsWithPipe);
  const offset = contentsWithPipe.indexOf('|');
  const contents =
    contentsWithPipe.slice(0, offset) + contentsWithPipe.slice(offset + 1);
  const ide = new IdeAnalyzer();
  ide.setOpenFileContents(options.rig.resolve('package.json'), contents);
  const actions = await ide.getCodeActions(
    options.rig.resolve('package.json'),
    OffsetToPositionConverter.createUncachedForTest(contents).toIdeRange({
      offset,
      length: 0,
    })
  );
  return {contents, actions};
}

async function assertCodeAction(options: {
  rig: WireitTestRig;
  contentsWithPipe: string | object;
  expectedOutput: string | object;
  expectedTitle: string;
}) {
  const {contentsWithPipe, expectedOutput} = options;
  if (
    typeof contentsWithPipe === 'object' &&
    typeof expectedOutput === 'object'
  ) {
    // Verify that we behave correctly even in the face of different formatting.
    await assertCodeAction({
      ...options,
      contentsWithPipe: JSON.stringify(contentsWithPipe, null, 2),
    });
    await assertCodeAction({
      ...options,
      contentsWithPipe: JSON.stringify(contentsWithPipe, null, 8),
    });
    await assertCodeAction({
      ...options,
      contentsWithPipe: JSON.stringify(contentsWithPipe, null, '\t'),
    });
  }
  const {actions, contents} = await getCodeActions(options);
  assert.equal(
    actions.map((a) => a.title),
    [options.expectedTitle],
    `Error getting code actions for ${JSON.stringify(options.contentsWithPipe)}`
  );
  const [action] = actions;
  const newContents = applyEdit(options.rig, contents, action);
  if (typeof options.expectedOutput === 'string') {
    assert.equal(newContents, options.expectedOutput);
  } else {
    assert.equal(JSON.parse(newContents), options.expectedOutput);
  }
}

async function assertNoCodeActions(options: {
  rig: WireitTestRig;
  contentsWithPipe: string | object;
}) {
  const {actions} = await getCodeActions(options);
  assert.equal(
    actions.map((a) => a.title),
    [],
    `Expected no code action in: ${JSON.stringify(options.contentsWithPipe)}\n`
  );
}

function applyEdit(
  rig: WireitTestRig,
  before: string,
  action: CodeAction
): string {
  if (action.edit === undefined) {
    throw new Error(`Action ${action.title} had no edit`);
  }
  const edit = action.edit;
  assert.equal(Object.keys(edit), ['changes']);
  const filename = rig.resolve('package.json');
  assert.equal(Object.keys(edit?.changes ?? {}), [filename]);
  const textEdits = edit?.changes?.[filename];
  if (textEdits === undefined) {
    throw new Error(`Action ${action.title} had no edits for ${filename}`);
  }
  const converter = OffsetToPositionConverter.createUncachedForTest(before);
  return jsonParser.applyEdits(
    before,
    textEdits.map((e): jsonParser.Edit => {
      return {
        content: e.newText,
        ...converter.ideRangeToRange(e.range),
      };
    })
  );
}

test('can refactor a script to use wireit', async ({rig}) => {
  await assertCodeAction({
    rig,
    contentsWithPipe: {scripts: {test: "echo| 'test'"}},
    expectedOutput: {
      scripts: {test: 'wireit'},
      wireit: {test: {command: "echo 'test'"}},
    },
    expectedTitle: 'Refactor this script to use wireit.',
  });

  await assertCodeAction({
    rig,
    contentsWithPipe: {scripts: {'te|st': "echo 'test'"}},
    expectedOutput: {
      scripts: {test: 'wireit'},
      wireit: {test: {command: "echo 'test'"}},
    },
    expectedTitle: 'Refactor this script to use wireit.',
  });

  await assertCodeAction({
    rig,
    contentsWithPipe: {scripts: {'te|st': "echo 'test'"}, wireit: {}},
    expectedOutput: {
      scripts: {test: 'wireit'},
      wireit: {test: {command: "echo 'test'"}},
    },
    expectedTitle: 'Refactor this script to use wireit.',
  });

  await assertCodeAction({
    rig,
    contentsWithPipe: {
      scripts: {'te|st': "echo 'test'"},
      wireit: {unrelated: {}},
    },
    expectedOutput: {
      scripts: {test: 'wireit'},
      wireit: {test: {command: "echo 'test'"}, unrelated: {}},
    },
    expectedTitle: 'Refactor this script to use wireit.',
  });
});

test(`we don't do code actions when there are syntax or type errors`, async ({
  rig,
}) => {
  // trailing comma
  await assertNoCodeActions({
    rig,
    contentsWithPipe: JSON.stringify({scripts: {test: "echo| 'test'"}}) + ',',
  });

  // wireit section is string
  await assertNoCodeActions({
    rig,
    contentsWithPipe: {scripts: {test: "echo| 'test'"}, wireit: 'bad'},
  });

  // wireit section is array
  await assertNoCodeActions({
    rig,
    contentsWithPipe: {scripts: {test: "echo| 'test'"}, wireit: []},
  });
});

test(`we try to match the existing file's formatting`, async ({rig}) => {
  await assertCodeAction({
    rig,
    contentsWithPipe: `{"scripts": {"test": "echo| 'test'"}}`,
    expectedOutput: `{"scripts": {"test": "wireit"},"wireit": {"test":{"command":"echo 'test'"}}}`,
    expectedTitle: 'Refactor this script to use wireit.',
  });

  await assertCodeAction({
    rig,
    contentsWithPipe: `{
  "scripts": {
    "test": "echo| 'test'"
  }
}`,
    expectedOutput: `{
  "scripts": {
    "test": "wireit"
  },
  "wireit": {
    "test": {
      "command": "echo 'test'"
    }
  }
}`,
    expectedTitle: 'Refactor this script to use wireit.',
  });

  await assertCodeAction({
    rig,
    contentsWithPipe: `{
    "scripts": {
      "test": "echo| 'test'"
    }
}`,
    expectedOutput: `{
    "scripts": {
      "test": "wireit"
    },
    "wireit": {
        "test": {
            "command": "echo 'test'"
        }
    }
}`,
    expectedTitle: 'Refactor this script to use wireit.',
  });

  await assertCodeAction({
    rig,
    contentsWithPipe: `{
\t"scripts": {
\t\t"test": "echo| 'test'"
\t}
}`,
    expectedOutput: `{
\t"scripts": {
\t\t"test": "wireit"
\t},
\t"wireit": {
\t\t"test": {
\t\t\t"command": "echo 'test'"
\t\t}
\t}
}`,
    expectedTitle: 'Refactor this script to use wireit.',
  });
});

test(`we suggest adding a wireit-only script to scripts section`, async ({
  rig,
}) => {
  await assertCodeAction({
    rig,
    contentsWithPipe: {wireit: {foo: {command: "echo| 'test'"}}},
    expectedOutput: {
      scripts: {foo: 'wireit'},
      wireit: {foo: {command: "echo 'test'"}},
    },
    expectedTitle: 'Add this script to the "scripts" section.',
  });

  // No suggestion after the fix is applied.
  await assertNoCodeActions({
    rig,
    contentsWithPipe: {
      scripts: {foo: 'wireit'},
      wireit: {foo: {command: "echo| 'test'"}},
    },
  });
});

test(`we suggest moving command into wireit section`, async ({rig}) => {
  await assertCodeAction({
    rig,
    contentsWithPipe: {
      scripts: {foo: `echo| 'test'`},
      wireit: {foo: {}},
    },
    expectedOutput: {
      scripts: {foo: 'wireit'},
      wireit: {foo: {command: "echo 'test'"}},
    },
    expectedTitle: `Move this script's command into the wireit config.`,
  });

  await assertCodeAction({
    rig,
    contentsWithPipe: {
      scripts: {foo: `echo 'test'`},
      wireit: {foo: {['|dependencies']: []}},
    },
    expectedOutput: {
      scripts: {foo: 'wireit'},
      wireit: {foo: {dependencies: [], command: "echo 'test'"}},
    },
    expectedTitle: `Move this script's command into the wireit config.`,
  });

  await assertCodeAction({
    rig,
    contentsWithPipe: {
      scripts: {foo: `echo| 'test'`},
      wireit: {foo: {command: `echo 'test'`}},
    },
    expectedOutput: {
      scripts: {foo: 'wireit'},
      wireit: {foo: {command: "echo 'test'"}},
    },
    expectedTitle: `Run "wireit" in the scripts section.`,
  });

  await assertCodeAction({
    rig,
    contentsWithPipe: {
      scripts: {foo: `echo 'test'`},
      wireit: {foo: {command: "echo 'test'", ['|dependencies']: []}},
    },
    expectedOutput: {
      scripts: {foo: 'wireit'},
      wireit: {foo: {command: "echo 'test'", dependencies: []}},
    },
    expectedTitle: `Run "wireit" in the scripts section.`,
  });

  await assertCodeAction({
    rig,
    contentsWithPipe: {
      scripts: {foo: `echo |'foo'`},
      wireit: {foo: {command: "echo 'bar'"}},
    },
    expectedOutput: {
      scripts: {foo: 'wireit'},
      wireit: {
        foo: {command: "echo 'bar'", '[the script command was]': "echo 'foo'"},
      },
    },
    expectedTitle: `Move this script's command into the wireit config.`,
  });

  await assertCodeAction({
    rig,
    contentsWithPipe: {
      scripts: {foo: `echo 'foo'`},
      wireit: {foo: {command: "echo| 'bar'"}},
    },
    expectedOutput: {
      scripts: {foo: 'wireit'},
      wireit: {
        foo: {
          command: "echo 'bar'",
          '[the script command was]': "echo 'foo'",
        },
      },
    },
    expectedTitle: `Move this script's command into the wireit config.`,
  });
});

test.run();
