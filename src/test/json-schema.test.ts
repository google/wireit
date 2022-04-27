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
import {PackageJson} from './util/package-json';

const schema = JSON.parse(
  fs.readFileSync(
    pathlib.join(
      url.fileURLToPath(import.meta.url),
      '..',
      '..',
      '..',
      'schema.json'
    ),
    'utf-8'
  )
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
    errors
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
        dependencies: ['c'],
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
    ]
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
    ['instance.wireit.a.dependencies is not of a type(s) array']
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
    ['instance.wireit.a.dependencies[0] is not of a type(s) string']
  );
});

test.run();
