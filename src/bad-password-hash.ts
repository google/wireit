/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// This file is just here to see if the
// https://github.com/github/codeql/blob/main/javascript/ql/src/Security/CWE-916/examples/InsufficientPasswordHash.js
// check triggers.

import * as crypto from 'crypto';

export function hashPassword(password: string) {
  const hasher = crypto.createHash('md5');
  const hashed = hasher.update(password).digest('hex');
  return hashed;
}
