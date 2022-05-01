/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {drawSquiggleUnderRange} from '../error.js';

const test = suite();

test('drawing squiggles under ranges in single-line files', () => {
  assert.equal(drawSquiggleUnderRange({offset: 0, length: 0}, 'H', 0), 'H\n');

  assert.equal(drawSquiggleUnderRange({offset: 0, length: 1}, 'H', 0), 'H\n~');

  assert.equal(
    drawSquiggleUnderRange({offset: 3, length: 3}, 'aaabbbccc', 0),
    `
aaabbbccc
   ~~~`.slice(1)
  );

  assert.equal(
    drawSquiggleUnderRange({offset: 3, length: 3}, 'aaabbbccc', 8),
    `
        aaabbbccc
           ~~~`.slice(1)
  );
});

test('drawing squiggles single-line ranges at the end of multi-line files', () => {
  assert.equal(
    drawSquiggleUnderRange({offset: 4, length: 0}, 'abc\nH\n', 0),
    'H\n'
  );

  assert.equal(
    drawSquiggleUnderRange({offset: 4, length: 1}, 'abc\nH\n', 0),
    'H\n~'
  );

  assert.equal(
    drawSquiggleUnderRange({offset: 7, length: 3}, 'abc\naaabbbccc', 0),
    `
aaabbbccc
   ~~~`.slice(1)
  );

  assert.equal(
    drawSquiggleUnderRange({offset: 7, length: 3}, 'abc\naaabbbccc', 8),
    `
        aaabbbccc
           ~~~`.slice(1)
  );
});

test('drawing squiggles under multi-line ranges', () => {
  assert.equal(
    drawSquiggleUnderRange({offset: 0, length: 0}, 'H\nabc', 0),
    'H\n'
  );

  assert.equal(
    drawSquiggleUnderRange({offset: 0, length: 1}, 'H\nabc', 0),
    'H\n~'
  );

  assert.equal(
    drawSquiggleUnderRange({offset: 3, length: 3}, 'aaabbbccc\nabc', 0),
    `
aaabbbccc
   ~~~`.slice(1)
  );

  assert.equal(
    drawSquiggleUnderRange({offset: 3, length: 3}, 'aaabbbccc\nabc', 8),
    `
        aaabbbccc
           ~~~`.slice(1)
  );
});

test('drawing squiggles under multi-line ranges', () => {
  assert.equal(
    drawSquiggleUnderRange({offset: 0, length: 0}, 'abc\ndef\nhij', 0),
    `
abc
`.slice(1)
  );

  assert.equal(
    drawSquiggleUnderRange({offset: 0, length: 5}, 'abc\ndef\nhij', 0),
    `
abc
~~~
def
~`.slice(1)
  );

  // include the newline at the end of the first line
  assert.equal(
    drawSquiggleUnderRange({offset: 0, length: 4}, 'abc\ndef\nhij', 0),
    `
abc
~~~
def
`.slice(1)
  );

  // include _only_ the newline at the end of the first line
  assert.equal(
    drawSquiggleUnderRange({offset: 3, length: 1}, 'abc\ndef\nhij', 0),
    `
abc
${'   '}
def
`.slice(1)
  );

  assert.equal(
    drawSquiggleUnderRange({offset: 3, length: 2}, 'abc\ndef\nhij', 0),
    `
abc
${'   '}
def
~`.slice(1)
  );

  assert.equal(
    drawSquiggleUnderRange({offset: 2, length: 7}, 'abc\ndef\nhij', 0),
    `
abc
  ~
def
~~~
hij
~`.slice(1)
  );
});

test.run();
