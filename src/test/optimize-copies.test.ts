/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {test} from 'uvu';
import * as assert from 'uvu/assert';
import {optimizeCopies} from '../util/optimize-fs-ops.js';
import {shuffle} from '../util/shuffle.js';
import * as pathlib from 'path';

const IS_WINDOWS = process.platform === 'win32';

const windowsifyPathIfOnWindows = (path: string) =>
  IS_WINDOWS ? path.replaceAll(pathlib.posix.sep, pathlib.win32.sep) : path;

const check = (input: string[], expected: string[]) =>
  assert.equal(
    optimizeCopies(input.map(windowsifyPathIfOnWindows)).sort(),
    expected.map(windowsifyPathIfOnWindows).sort()
  );

test('empty', () => {
  check([], []);
});

test('1 item', () => {
  check(['a'], ['a']);
});

test('2 independent items', () => {
  check(['a', 'b'], ['a', 'b']);
});

test('parent and child', () => {
  check(['a', 'a/b'], ['a']);
});

test('parent and child in reverse order', () => {
  check(['a/b', 'a'], ['a']);
});

test('parent and not-child but shared prefix', () => {
  // "ax" starts with "a", but that doesn't mean it's a child. Only if it starts
  // with "a/" would it be.
  check(['a', 'ax/b'], ['a', 'ax/b']);
});

test('multiple children', () => {
  // "a/b" starts with "a/", but "a/c" does not start with "a/b".
  check(['a', 'a/b', 'a/c'], ['a']);
});

test('duplicates', () => {
  check(['a', 'a'], ['a']);
});

test('leading slash is significant', () => {
  check(['a', '/a'], ['/a', 'a']);
});

test('various shuffled cases', () => {
  const input = [
    'a',
    'a',
    'a/b',
    'a/b/c',
    'a/b/c/d',
    'ab',
    'abc',
    'b/c/d/e1',
    'b/c/d/e2',
    'b/c/d/e2',
    'b/c/d/e3',
    'b/c/d/e3',
    'b/c/d/e3',
    'c/d/e',
    'd/e',
  ];
  const expected = [
    'a',
    'ab',
    'abc',
    'b/c/d/e1',
    'b/c/d/e2',
    'b/c/d/e3',
    'c/d/e',
    'd/e',
  ];
  for (let i = 0; i < 1000; i++) {
    shuffle(input);
    check(input, expected);
  }
});

test.run();
