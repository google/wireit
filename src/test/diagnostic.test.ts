/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {test} from 'uvu';
import * as assert from 'uvu/assert';
import {drawSquiggle, OffsetToPositionConverter, Position} from '../error.js';
import {JsonAstNode} from '../util/ast.js';

function assertSquiggleAndPosition(
  {
    offset,
    length,
    contents,
    indent,
  }: {offset: number; length: number; contents: string; indent?: number},
  expectedSquiggle: string,
  expectedPosition: Position
) {
  const squiggle = drawSquiggle(
    {
      range: {offset, length},
      file: {
        path: 'package.json',
        ast: null as unknown as JsonAstNode,
        contents,
      },
    },
    indent ?? 0
  );
  const position = new OffsetToPositionConverter(contents).toPosition(offset);
  if (expectedSquiggle[0] !== '\n') {
    throw new Error(
      `Test authoring error: write the expected squiggle as a template string with a leading newline.`
    );
  }
  assert.equal(squiggle, expectedSquiggle.slice(1));
  assert.equal(position, expectedPosition);
}

test('drawing squiggles under ranges in single-line files', () => {
  assertSquiggleAndPosition(
    {
      offset: 0,
      length: 0,
      contents: 'H',
    },
    `
H
`,
    {line: 1, column: 1}
  );

  assertSquiggleAndPosition(
    {
      offset: 3,
      length: 3,
      contents: 'aaabbbccc',
    },
    `
aaabbbccc
   ~~~`,
    {line: 1, column: 4}
  );

  assertSquiggleAndPosition(
    {
      offset: 3,
      length: 3,
      contents: 'aaabbbccc',
      indent: 8,
    },
    `
        aaabbbccc
           ~~~`,
    {line: 1, column: 4}
  );
});

test('drawing squiggles single-line ranges at the end of multi-line files', () => {
  assertSquiggleAndPosition(
    {
      offset: 4,
      length: 0,
      contents: 'abc\nH\n',
    },
    `
H
`,
    {line: 2, column: 1}
  );

  assertSquiggleAndPosition(
    {
      offset: 4,
      length: 1,
      contents: 'abc\nH\n',
    },
    `
H
~`,
    {line: 2, column: 1}
  );

  assertSquiggleAndPosition(
    {
      offset: 4,
      length: 1,
      contents: 'abc\nH\n',
    },
    `
H
~`,
    {line: 2, column: 1}
  );

  assertSquiggleAndPosition(
    {offset: 7, length: 3, contents: 'abc\naaabbbccc'},
    `
aaabbbccc
   ~~~`,
    {line: 2, column: 4}
  );

  assertSquiggleAndPosition(
    {
      offset: 7,
      length: 3,
      contents: 'abc\naaabbbccc',
      indent: 8,
    },

    `
        aaabbbccc
           ~~~`,
    {line: 2, column: 4}
  );
});

test('drawing squiggles under multi-line ranges', () => {
  assertSquiggleAndPosition(
    {
      offset: 0,
      length: 0,
      contents: 'H\nabc',
    },
    `
H
`,
    {line: 1, column: 1}
  );

  assertSquiggleAndPosition(
    {
      offset: 0,
      length: 1,
      contents: 'H\nabc',
    },
    `
H
~`,
    {line: 1, column: 1}
  );

  assertSquiggleAndPosition(
    {
      offset: 3,
      length: 3,
      contents: 'aaabbbccc\nabc',
    },
    `
aaabbbccc
   ~~~`,
    {line: 1, column: 4}
  );

  assertSquiggleAndPosition(
    {
      offset: 3,
      length: 3,
      contents: 'aaabbbccc\nabc',
      indent: 8,
    },
    `
        aaabbbccc
           ~~~`,
    {line: 1, column: 4}
  );
});

test('drawing squiggles under one line of a multi-line input', () => {
  assertSquiggleAndPosition(
    {offset: 0, length: 0, contents: 'abc\ndef\nhij'},
    `
abc
`,
    {line: 1, column: 1}
  );

  assertSquiggleAndPosition(
    {offset: 0, length: 5, contents: 'abc\ndef\nhij'},
    `
abc
~~~
def
~`,
    {line: 1, column: 1}
  );

  // include the newline at the end of the first line
  assertSquiggleAndPosition(
    {offset: 0, length: 4, contents: 'abc\ndef\nhij'},
    `
abc
~~~
def
`,
    {line: 1, column: 1}
  );

  // include _only_ the newline at the end of the first line
  assertSquiggleAndPosition(
    {offset: 3, length: 1, contents: 'abc\ndef\nhij'},
    `
abc
${'   '}
def
`,
    {line: 1, column: 4}
  );

  assertSquiggleAndPosition(
    {offset: 3, length: 2, contents: 'abc\ndef\nhij'},
    `
abc
${'   '}
def
~`,
    {line: 1, column: 4}
  );

  assertSquiggleAndPosition(
    {offset: 2, length: 7, contents: 'abc\ndef\nhij'},
    `
abc
  ~
def
~~~
hij
~`,
    {line: 1, column: 3}
  );
});

test.run();
