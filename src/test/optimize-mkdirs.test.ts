/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import 'source-map-support/register.js';
import {test} from 'uvu';
import * as assert from 'uvu/assert';
import {optimizeMkdirs} from '../util/optimize-fs-ops.js';
import {shuffle} from '../util/shuffle.js';
import {windowsifyPathIfOnWindows} from './util/windows.js';

const check = (input: string[], expected: string[]) =>
  assert.equal(
    optimizeMkdirs(input.map(windowsifyPathIfOnWindows)).sort(),
    expected.map(windowsifyPathIfOnWindows).sort()
  );

test('empty', () => {
  check([], []);
});

test('1 item', () => {
  check(['a'], ['a']);
});

test('duplicates', () => {
  check(['a', 'a'], ['a']);
});

test('parent and children', () => {
  check(['a', 'a/b', 'a/b/c'], ['a/b/c']);
});

test('parent and child reversed', () => {
  check(['a/b/c', 'a/b', 'a'], ['a/b/c']);
});

test('various shuffled cases', () => {
  const input = [
    '',
    'a/b/c',
    'd/e/f',
    'd/e/f',
    'd/e/f',
    'foo/bar/baz',
    'foo/bar',
    'foo',
    '1/2/3/4/5',
    '1/2/3/4/5',
    '1/2/3/4',
    '1/2/3',
    '1/2',
    '1',
  ];
  const expected = ['', 'a/b/c', 'd/e/f', 'foo/bar/baz', '1/2/3/4/5'];
  for (let i = 0; i < 1000; i++) {
    shuffle(input);
    check(input, expected);
  }
});

test.run();
