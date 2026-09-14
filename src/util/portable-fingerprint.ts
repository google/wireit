/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createHash} from 'crypto';
import * as pathlib from 'path';
import {stringToScriptReference} from '../config.js';
import type {ScriptReferenceString} from '../config.js';

import type {Fingerprint} from '../fingerprint.js';

/**
 * SHA-256 of {@link portableFingerprintString}. Used as the local cache
 * directory name so two checkouts of the same tree share entries.
 *
 * GitHub Actions caching still uses {@link Fingerprint.string} and is
 * unchanged.
 */
export const hashPortableFingerprint = (
  fingerprint: Fingerprint,
  packageDir: string,
): string =>
  createHash('sha256')
    .update(portableFingerprintString(fingerprint, packageDir))
    .digest('hex');

/**
 * Rewrite fingerprint JSON so file and dependency keys are relative to
 * {@link packageDir}. Non-JSON fingerprints (unit-test fakes) pass through.
 */
export const portableFingerprintString = (
  fingerprint: Fingerprint,
  packageDir: string,
): string => {
  const parsed: unknown = parseJson(fingerprint.string);
  if (!isFingerprintLike(parsed)) {
    return fingerprint.string;
  }
  const absPackageDir = pathlib.resolve(packageDir);
  const files = Object.fromEntries(
    Object.entries(parsed.files)
      .map(([path, hash]) => [relativize(absPackageDir, path), hash] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const dependencies = Object.fromEntries(
    Object.entries(parsed.dependencies)
      .map(
        ([key, hash]) =>
          [relativizeDependencyKey(absPackageDir, key), hash] as const,
      )
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return JSON.stringify({...parsed, files, dependencies});
};

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};

const isFingerprintLike = (
  value: unknown,
): value is {
  files: Record<string, string>;
  dependencies: Record<string, string>;
} =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  isStringRecord((value as {files?: unknown}).files) &&
  isStringRecord((value as {dependencies?: unknown}).dependencies);

const isStringRecord = (value: unknown): value is Record<string, string> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((item) => typeof item === 'string');
};

const relativize = (packageDir: string, path: string): string => {
  if (!pathlib.isAbsolute(path)) {
    return path;
  }
  const relative = pathlib.relative(packageDir, path);
  return relative === '' ? '.' : relative;
};

const relativizeDependencyKey = (packageDir: string, key: string): string => {
  try {
    const {packageDir: depPackageDir, name} = stringToScriptReference(
      key as ScriptReferenceString,
    );
    return JSON.stringify([relativize(packageDir, depPackageDir), name]);
  } catch {
    return key;
  }
};
