/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Parse a positive integer from an environment variable, or return undefined
 * for anything else.
 *
 * Surrounding whitespace, a leading "+", and leading zeroes are accepted,
 * because parseInt accepted them. Trailing characters, fractions, exponents,
 * and integers too large to represent exactly are rejected, where parseInt or
 * Number would have silently read a different value.
 */
export function parsePositiveInteger(value: string): number | undefined {
  const normalized = value.trim();
  if (!/^\+?\d+$/.test(normalized)) {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
