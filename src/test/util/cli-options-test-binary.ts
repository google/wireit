/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// This file is a binary that is used to directly test command-line option
// parsing.

import {getOptions} from '../../cli-options.js';
import {writeFileSync} from 'fs';

writeFileSync('options.json', JSON.stringify(getOptions()));
