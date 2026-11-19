/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {test} from 'node:test';
import * as assert from 'node:assert';
import {EventEmitter} from 'node:events';

import {LineMonitor} from '../util/line-monitor.js';

import type {ScriptChildProcess} from '../script-child-process.js';

interface FakeChild {
  child: ScriptChildProcess;
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function makeFakeChild(): FakeChild {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = {stdout, stderr} as unknown as ScriptChildProcess;
  return {child, stdout, stderr};
}

test(
  'LineMonitor matches a line split across chunks at line boundaries',
  async () => {
    const {child, stdout} = makeFakeChild();
    const monitor = new LineMonitor(child, /Listening on port \d+\./);

    stdout.emit('data', 'Foo\nBar\nListening ');
    await new Promise((resolve) => setTimeout(resolve, 10));
    stdout.emit('data', 'on port 8080.');

    assert.ok((await monitor.matched).ok);
  },
);

test(
  'LineMonitor matches a UTF-8 character split across stdout chunks',
  async () => {
    const {child, stdout} = makeFakeChild();
    const monitor = new LineMonitor(child, /準備完成/);

    const bytes = Buffer.from('準備完成\n');
    // Emit the first byte of the first 3-byte UTF-8 character, then the rest.
    stdout.emit('data', bytes.subarray(0, 1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    stdout.emit('data', bytes.subarray(1));

    assert.ok((await monitor.matched).ok);
  },
);

test(
  'LineMonitor matches a UTF-8 character split across stderr chunks',
  async () => {
    const {child, stderr} = makeFakeChild();
    const monitor = new LineMonitor(child, /準備完成/);

    const bytes = Buffer.from('準備完成\n');
    stderr.emit('data', bytes.subarray(0, 1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    stderr.emit('data', bytes.subarray(1));

    assert.ok((await monitor.matched).ok);
  },
);

test(
  'LineMonitor does not match before the readiness text completes',
  async () => {
    const {child, stdout} = makeFakeChild();
    const monitor = new LineMonitor(child, /Listening on port \d+\./);

    stdout.emit('data', 'Listening on po');
    let matched = false;
    void monitor.matched.then(() => {
      matched = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(!matched);

    stdout.emit('data', 'rt 8080.');
    assert.ok((await monitor.matched).ok);
  },
);

test('LineMonitor abort resolves matched as not ok', async () => {
  const {child} = makeFakeChild();
  const monitor = new LineMonitor(child, /never matches/);
  monitor.abort();
  assert.ok(!(await monitor.matched).ok);
});
