/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ScriptReferenceString} from './script.js';

/**
 * All meaningful inputs of a script. Used for determining if a script is fresh,
 * and as the key for storing cached output.
 */
export interface FingerprintData {
  /**
   * Whether the output for this script can be fresh or cached.
   *
   * True only if the "files" array was defined for this script, and for all of
   * this script's transitive dependencies.
   */
  cacheable: boolean;

  /** E.g. linux, win32 */
  platform: NodeJS.Platform;

  /** E.g. x64 */
  arch: string;

  /** E.g. 16.7.0 */
  nodeVersion: string;

  /**
   * The shell command from the Wireit config.
   */
  command: string | undefined;

  /**
   * The "clean" setting from the Wireit config.
   *
   * This is included in the fingerprint because switching from "false" to "true"
   * could produce different output, so a re-run should be triggered even if
   * nothing else changed.
   */
  clean: boolean | 'if-file-deleted';

  // Must be sorted.
  files: {[packageDirRelativeFilename: string]: Sha256HexDigest};

  /**
   * The "output" glob patterns from the Wireit config.
   *
   * This is included in the fingerprint because changing the output patterns
   * could produce different output when "clean" is true, and because it affects
   * which files get included in a cache entry.
   *
   * Note the undefined vs empty-array distinction is not meaningful here,
   * because both cases cause no files to be deleted, and the undefined case is
   * never cached anyway.
   */
  output: string[];

  // Must be sorted.
  dependencies: {[dependency: ScriptReferenceString]: FingerprintData};
}

/**
 * String serialization of a {@link FingerprintData}.
 */
export type FingerprintString = string & {
  __FingerprintStringBrand__: never;
};

/**
 * SHA256 hash hexadecimal digest of a file's content.
 */
export type Sha256HexDigest = string & {
  __Sha256HexDigestBrand__: never;
};

/**
 * A script fingerprint. Can be initialized from either an object or a string,
 * and converts to the other form lazily with caching.
 */
export class Fingerprint {
  static fromString(string: FingerprintString): Fingerprint {
    const fingerprint = new Fingerprint();
    fingerprint.#str = string;
    return fingerprint;
  }

  static fromData(data: FingerprintData): Fingerprint {
    const fingerprint = new Fingerprint();
    fingerprint.#data = data;
    return fingerprint;
  }

  #str?: FingerprintString;
  #data?: FingerprintData;

  get string(): FingerprintString {
    if (this.#str === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.#str = JSON.stringify(this.#data!) as FingerprintString;
    }
    return this.#str;
  }

  get data(): FingerprintData {
    if (this.#data === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.#data = JSON.parse(this.#str!) as FingerprintData;
    }
    return this.#data;
  }

  equal(other: Fingerprint): boolean {
    return this.string === other.string;
  }
}
