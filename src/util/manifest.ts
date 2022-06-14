/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Stats} from 'fs';

/**
 * Metadata about a file which we use as a heuristic to decide whether two files
 * are equal without needing to read its contents.
 */
export interface FileManifestEntry {
  /** File type */
  t:
    | /** File */ 'f'
    | /** Directory */ 'd'
    | /** Symbolic link */ 'l'
    | /** Block device */ 'b'
    | /** Character device */ 'c'
    | /** FIFO pipe */ 'p'
    | /** Socket */ 's'
    | /** Unknown */ '?';
  /** Last content modification time. `undefined` for directories. */
  m: number | undefined;
  /** Size in bytes. `undefined` for directories. */
  s: number | undefined;
}

/**
 * A JSON-serialized manifest of files.
 */
export type FileManifestString = string & {
  __OutputManifestStringBrand__: never;
};

export function computeManifestEntry(stats: Stats): FileManifestEntry {
  return {
    t: stats.isFile()
      ? 'f'
      : stats.isDirectory()
      ? 'd'
      : stats.isSymbolicLink()
      ? 'l'
      : stats.isBlockDevice()
      ? 'b'
      : stats.isCharacterDevice()
      ? 'c'
      : stats.isFIFO()
      ? 'p'
      : stats.isSocket()
      ? 's'
      : '?',
    // Don't include timestamp or size for directories, because they can change
    // when a child is added or removed. If we are tracking the child, then it
    // will have its own entry. If we are not tracking the child, then we don't
    // want it to affect the manifest.
    m: stats.isDirectory() ? undefined : stats.mtimeMs,
    s: stats.isDirectory() ? undefined : stats.size,
  };
}
