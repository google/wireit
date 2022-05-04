/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export function removeAciiColors(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[\d+m/g, '');
}
