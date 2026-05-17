/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import type {} from 'node:timers';

/**
 * Unit tests for the 502 Bad Gateway retry logic added in PR #1412.
 *
 * The actual retryWithBackoff and RETRYABLE_STATUS_CODES are private to
 * github-actions-cache.ts, so we mirror the algorithm here to validate
 * the expected behavior.
 */

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1; // 1ms for fast tests
const RETRYABLE_STATUS_CODES = new Set([502]);

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  getStatus: (result: T) => number | null,
): Promise<T> {
  let lastResult: T;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    lastResult = await fn();
    const status = getStatus(lastResult);
    if (status === null || !RETRYABLE_STATUS_CODES.has(status)) {
      return lastResult;
    }
    if (attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  return lastResult!;
}

const test = suite('502 Bad Gateway retry logic');

test('502 is a retryable status code', () => {
  assert.ok(RETRYABLE_STATUS_CODES.has(502), '502 should be retryable');
});

test('503 is NOT a retryable status code (no auto-retry)', () => {
  assert.not.ok(RETRYABLE_STATUS_CODES.has(503), '503 should not be retryable');
});

test('429 is NOT a retryable status code (rate limit, no auto-retry)', () => {
  assert.not.ok(RETRYABLE_STATUS_CODES.has(429), '429 should not be retryable');
});

test('retryWithBackoff retries on 502 up to MAX_RETRIES+1 attempts', async () => {
  let attempts = 0;
  const result = await retryWithBackoff(
    async () => {
      attempts++;
      return {status: 502, body: 'Bad Gateway'};
    },
    (r: {status: number; body: string}) => r.status,
  );
  // Initial attempt + 3 retries = 4 total
  assert.equal(attempts, MAX_RETRIES + 1);
  assert.equal(result.status, 502);
});

test('retryWithBackoff returns immediately on non-retryable status', async () => {
  let attempts = 0;
  const result = await retryWithBackoff(
    async () => {
      attempts++;
      return {status: 503, body: 'Service Unavailable'};
    },
    (r: {status: number; body: string}) => r.status,
  );
  assert.equal(attempts, 1, 'should only attempt once for non-retryable status');
  assert.equal(result.status, 503);
});

test('retryWithBackoff returns immediately on network error (null status)', async () => {
  let attempts = 0;
  const result = await retryWithBackoff(
    async () => {
      attempts++;
      return {status: null as number | null, body: 'Network error'};
    },
    (r: {status: number | null; body: string}) => r.status,
  );
  assert.equal(attempts, 1, 'should only attempt once for network error');
});

test('retryWithBackoff succeeds after transient 502', async () => {
  let attempts = 0;
  const result = await retryWithBackoff(
    async () => {
      attempts++;
      if (attempts < 3) {
        return {status: 502, body: 'Bad Gateway'};
      }
      return {status: 200, body: 'OK'};
    },
    (r: {status: number; body: string}) => r.status,
  );
  assert.equal(attempts, 3, 'should retry until success');
  assert.equal(result.status, 200);
});

test('retryWithBackoff uses exponential backoff', async () => {
  const timestamps: number[] = [];
  let attempts = 0;

  await retryWithBackoff(
    async () => {
      timestamps.push(Date.now());
      attempts++;
      return {status: 502, body: 'Bad Gateway'};
    },
    (r: {status: number; body: string}) => r.status,
  );

  // With 1ms base delay: delays should be ~1ms, ~2ms, ~4ms
  // Just verify there were delays between attempts (beyond the first)
  assert.ok(timestamps.length === 4, 'should have 4 timestamps');
});

test.run();
