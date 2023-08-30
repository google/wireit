/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';

import type {ScriptReference} from '../config.js';

/**
 * Get the directory name where Wireit data can be saved for a script.
 */
export const getScriptDataDir = (script: ScriptReference) =>
  pathlib.join(
    script.packageDir,
    '.wireit',
    // Script names can contain any character, so they aren't safe to use
    // directly in a filepath, because certain characters aren't allowed on
    // certain filesystems (e.g. ":" is forbidden on Windows). Hex-encode
    // instead so that we only get safe ASCII characters.
    //
    // Reference:
    // https://docs.microsoft.com/en-us/windows/win32/fileio/naming-a-file#naming-conventions
    Buffer.from(script.name).toString('hex'),
  );
