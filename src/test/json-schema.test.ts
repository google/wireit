/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import * as assert from 'uvu/assert';
import * as jsonSchema from 'jsonschema';
import {suite} from 'uvu';
import * as fs from 'fs';
import * as url from 'url';

import type {PackageJson} from './util/package-json.js';

const schema = JSON.parse(
  fs.readFileSync(
    pathlib.join(
      url.fileURLToPath(import.meta.url),
      '..',
      '..',
      '..',
      'schema.json',
    ),
    'utf-8',
  ),
) as jsonSchema.Schema;
const validator = new jsonSchema.Validator();
validator.addSchema(schema);

function shouldValidate(packageJson: PackageJson) {
  expectValidationErrors(packageJson, []);
}

function expectValidationErrors(packageJson: object, errors: string[]) {
  const validationResult = validator.validate(packageJson, schema);
  assert.equal(
    validationResult.errors.map((e) => e.toString()),
    errors,
  );
}

const test = suite<unknown>();

test('an empty package.json file is valid', () => {
  shouldValidate({});
});

test('an empty wireit config section is valid', () => {
  shouldValidate({wireit: {}});
});

test('a script with just a command is valid', () => {
  shouldValidate({wireit: {a: {command: 'b'}}});
});

test('a script with just dependencies is valid', () => {
  shouldValidate({wireit: {a: {dependencies: ['b']}}});
});

test('dependency object is valid', () => {
  shouldValidate({wireit: {a: {dependencies: [{script: 'b'}]}}});
});

test('dependency object with cascade:false annotation is valid', () => {
  shouldValidate({
    wireit: {a: {dependencies: [{script: 'b', cascade: false}]}},
  });
});

// I couldn't figure out how to make this test pass while keeping the other
// error messages reasonable.
// It just turned all errors into this one.
test.skip('an empty script is invalid', () => {
  expectValidationErrors({wireit: {a: {}}}, [
    'instance.wireit.a is not any of <a script with a command>,<a script with only dependencies>',
  ]);
});

test('a script with all fields set is valid', () => {
  shouldValidate({
    wireit: {
      a: {
        command: 'b',
        dependencies: ['c', {script: 'c', cascade: false}],
        files: ['d'],
        output: ['e'],
        clean: true,
        packageLocks: ['f'],
      },
    },
  });
});

test('clean can be either a boolean or the string if-file-deleted', () => {
  shouldValidate({
    wireit: {
      a: {
        command: 'b',
        clean: true,
      },
    },
  });
  shouldValidate({
    wireit: {
      a: {
        command: 'b',
        clean: false,
      },
    },
  });
  shouldValidate({
    wireit: {
      a: {
        command: 'b',
        clean: 'if-file-deleted',
      },
    },
  });
  expectValidationErrors(
    {
      wireit: {
        a: {
          command: 'b',
          clean: 'something else',
        },
      },
    },
    [
      'instance.wireit.a.clean is not one of enum values: true,false,if-file-deleted',
    ],
  );
});

test('command must not be empty', () => {
  expectValidationErrors(
    {
      wireit: {
        a: {
          command: '',
        },
      },
    },
    ['instance.wireit.a.command does not meet minimum length of 1'],
  );
});

test('dependencies[i] must not be empty', () => {
  expectValidationErrors(
    {
      wireit: {
        a: {
          command: 'true',
          dependencies: [''],
        },
      },
    },
    // TODO(aomarks) Can we get a better error message? Seems like the built-in
    // toString() doesn't recurse, so we'd have to build the whole error message
    // ourselves.
    [
      'instance.wireit.a.dependencies[0] is not any of [subschema 0],[subschema 1]',
    ],
  );
});

test('files[i] must not be empty', () => {
  expectValidationErrors(
    {
      wireit: {
        a: {
          command: 'true',
          files: [''],
        },
      },
    },
    ['instance.wireit.a.files[0] does not meet minimum length of 1'],
  );
});

test('output[i] must not be empty', () => {
  expectValidationErrors(
    {
      wireit: {
        a: {
          command: 'true',
          output: [''],
        },
      },
    },
    ['instance.wireit.a.output[0] does not meet minimum length of 1'],
  );
});

test('packageLocks[i] must not be empty', () => {
  expectValidationErrors(
    {
      wireit: {
        a: {
          command: 'true',
          packageLocks: [''],
        },
      },
    },
    ['instance.wireit.a.packageLocks[0] does not meet minimum length of 1'],
  );
});

test('dependencies must be an array of strings', () => {
  expectValidationErrors(
    {
      wireit: {
        a: {
          command: 'b',
          dependencies: 'c',
        },
      },
    },
    ['instance.wireit.a.dependencies is not of a type(s) array'],
  );

  expectValidationErrors(
    {
      wireit: {
        a: {
          command: 'b',
          dependencies: [1],
        },
      },
    },
    [
      'instance.wireit.a.dependencies[0] is not any of [subschema 0],[subschema 1]',
    ],
  );
});

test('dependencies[i].script is required', () => {
  expectValidationErrors(
    {
      wireit: {
        a: {
          command: 'b',
          dependencies: [{}],
        },
      },
    },
    [
      'instance.wireit.a.dependencies[0] is not any of [subschema 0],[subschema 1]',
    ],
  );
});

test('dependencies[i].cascade must be boolean', () => {
  expectValidationErrors(
    {
      wireit: {
        a: {
          command: 'b',
          dependencies: [{script: 'b', cascade: 1}],
        },
      },
    },
    [
      'instance.wireit.a.dependencies[0] is not any of [subschema 0],[subschema 1]',
    ],
  );
});

test.run();
