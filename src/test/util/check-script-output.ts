/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'uvu/assert';
import {removeAnsiColors} from './colors.js';
import {NODE_MAJOR_VERSION} from './node-version.js';

/**
 * The npm version that ships with with Node 14 produces a bunch of additional
 * logs when running a script, so we need to use the less strict `assert.match`.
 * However, `assert.equal` gives a better error message, so we reproduce that
 * manually.
 */
export function checkScriptOutput(
  actual: string,
  expected: string,
  message?: string
) {
  actual = removeOverwrittenLines(removeAnsiColors(actual)).trim();
  expected = expected.trim();
  if (actual !== expected) {
    for (let i = 0; i < actual.length; i++) {
      if (actual[i] !== expected[i]) {
        console.log(`${i}: ${actual[i]} !== ${expected[i]}`);
        break;
      }
    }

    console.log(`Copy-pastable output:\n${actual}`);
    for (let i = 0; i < actual.length; i++) {
      if (actual[i] !== expected[i]) {
        console.log(`${i}: ${actual[i]} !== ${expected[i]}`);
        break;
      }
    }
  }
  const assertOutputEqualish =
    NODE_MAJOR_VERSION < 16 ? assert.match : assert.equal;
  assertOutputEqualish(actual, expected, message);
}

/**
 * Remove content that's overwritten with a \r
 */
function removeOverwrittenLines(output: string) {
  const lines = output.split('\n');
  const result = [];
  for (const line of lines) {
    let content = '';
    const splits = line.split('\r');
    for (const split of splits) {
      // This split overrides the content up to its length, and then
      // any additional content from the previous line is retained.
      content = split + content.slice(split.length).trimEnd();
    }
    result.push(content);
  }
  return result.join('\n');
}
