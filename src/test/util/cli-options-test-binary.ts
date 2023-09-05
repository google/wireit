/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// This file is a binary that is used to directly test command-line option
// parsing.

import {Options, getOptions} from '../../cli-options.js';
import {writeFileSync} from 'fs';
import {Result} from '../../error.js';

type SerializableOptions = Omit<Options, 'logger'> & {
  logger: string;
};

const options = await getOptions() as unknown as Result<SerializableOptions>;
if (options.ok) {
  options.value.logger = options.value.logger.constructor.name;
}
writeFileSync('options.json', JSON.stringify(options));
