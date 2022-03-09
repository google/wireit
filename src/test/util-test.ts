/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {
  changeGlobDirectory,
  expandGlobCurlyGroups,
} from '../shared/rewrite-glob.js';

{
  const test = suite('changeGlobDirectory');

  test('simple', () => {
    assert.equal(
      changeGlobDirectory('src/**/*.js', 'packages/foo'),
      'packages/foo/src/**/*.js'
    );
  });

  test('negated', () => {
    assert.equal(
      changeGlobDirectory('!src/**/*.js', 'packages/foo'),
      '!packages/foo/src/**/*.js'
    );
  });

  test('empty cwd', () => {
    assert.equal(changeGlobDirectory('src/**/*.js', ''), 'src/**/*.js');
  });

  test('empty cwd negated', () => {
    assert.equal(changeGlobDirectory('!src/**/*.js', ''), '!src/**/*.js');
  });

  test('relative cwd', () => {
    assert.equal(
      changeGlobDirectory('src/**/*.js', '../..'),
      '../../src/**/*.js'
    );
  });

  test('relative cwd negated', () => {
    assert.equal(
      changeGlobDirectory('!src/**/*.js', '../..'),
      '!../../src/**/*.js'
    );
  });

  test('absolute cwd + relative glob', () => {
    assert.equal(
      changeGlobDirectory('src/**/*.js', '/foo'),
      '/foo/src/**/*.js'
    );
  });

  test('absolute cwd + negated relative glob', () => {
    assert.equal(
      changeGlobDirectory('!src/**/*.js', '/foo'),
      '!/foo/src/**/*.js'
    );
  });

  test('absolute glob + absolute cwd', () => {
    assert.equal(
      changeGlobDirectory('/bar/src/**/*.js', '/foo'),
      '/bar/src/**/*.js'
    );
  });

  test('braces', () => {
    assert.equal(
      changeGlobDirectory('{foo,bar}/baz', 'packages/foo'),
      'packages/foo/{foo,bar}/baz'
    );
  });

  test('braces + absolute glob + absolute cwd', () => {
    assert.equal(
      changeGlobDirectory('{/bar,/baz}/src/**/*.js', '/foo'),
      '{/bar,/baz}/src/**/*.js'
    );
  });

  test('braces + mixed glob + absolute cwd', () => {
    assert.equal(
      changeGlobDirectory('{/bar,baz}/src/**/*.js', '/foo'),
      '{/bar,/foo/baz}/src/**/*.js'
    );
  });

  test('braces + mixed glob + relative cwd', () => {
    assert.equal(
      changeGlobDirectory('{/bar,baz}/src/**/*.js', '../xyz'),
      '{/bar,../xyz/baz}/src/**/*.js'
    );
  });

  test.run();
}

{
  const test = suite('expandGlobCurlyGroups');

  test('just a  curly group', () => {
    assert.equal(expandGlobCurlyGroups('{aaa,bbb}'), ['aaa', 'bbb']);
  });

  test('trailing curly group', () => {
    assert.equal(expandGlobCurlyGroups('*.{aaa,bbb}'), ['*.aaa', '*.bbb']);
  });

  test('leading curly group', () => {
    assert.equal(expandGlobCurlyGroups('{foo,bar}.aaa'), [
      'foo.aaa',
      'bar.aaa',
    ]);
  });

  test('two curly groups', () => {
    assert.equal(expandGlobCurlyGroups('{foo,bar}.{aaa,bbb}'), [
      'foo.aaa',
      'foo.bbb',
      'bar.aaa',
      'bar.bbb',
    ]);
  });

  test.run();
}
