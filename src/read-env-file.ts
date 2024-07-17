/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {readFile, stat} from 'node:fs/promises';

// TODO string-template-parser

export async function readEnvFile(filepath: string, entries: Array<[string, string]>): Promise<void> {
  const fileStat = await stat(filepath).catch(() => null);
  if (!fileStat || !fileStat.isFile()) {
    console.warn('Skipping non-file env file: ' + filepath);
    return;
  }
  const content = await readFile(filepath, 'utf8');
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      continue;
    }
    const [key, ...rest] = trimmed.split('=');
    if (rest.length === 0) {
      continue;
    }
    const value = rest.join('=');
    if (typeof key === 'string' && typeof value === 'string') {
      entries.push([key, value]);
    }
  }
}
