/**
 * @license
 * Copyright 2024 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import eslint from '@eslint/js';
import noOnlyTests from 'eslint-plugin-no-only-tests';
import tseslint from 'typescript-eslint';

/**
 * We want to be able to lint non-TypeScript files. If we don't guard our
 * TypeScript rules with a "files" constraint, eslint will try to lint all files
 * using the TypeScript parser, which will fail for projects outside a
 * TypeScript project. Maybe there is a simpler way to do this?
 */
const onlyTypeScriptFiles = (configs) =>
  configs.map((config) => ({...config, files: config.files ?? ['**/*.ts']}));

export default [
  {
    // List all visible files:
    //   npx eslint --debug 2>&1 | grep "eslint:eslint Lint" | cut -f 4- -d" " | sort
    ignores: [
      '**/.wireit/',
      '**/node_modules/',
      'lib/',
      'vscode-extension/.vscode-test/',
      'vscode-extension/lib/',
      'vscode-extension/built/',
    ],
  },
  eslint.configs.recommended,
  ...onlyTypeScriptFiles([
    ...tseslint.configs.strictTypeChecked,
    {
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir: import.meta.dirname,
        },
      },
      plugins: {
        'no-only-tests': noOnlyTests,
      },
      rules: {
        'no-only-tests/no-only-tests': 'error',
        '@typescript-eslint/no-unused-vars': [
          'error',
          {argsIgnorePattern: '^_', varsIgnorePattern: '^_'},
        ],
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/no-useless-constructor': 'off',
        '@typescript-eslint/only-throw-error': 'off',
        '@typescript-eslint/no-confusing-void-expression': 'off',
        '@typescript-eslint/restrict-template-expressions': 'off',
        '@typescript-eslint/no-unnecessary-condition': 'off',
        '@typescript-eslint/no-unnecessary-type-arguments': 'off',
        '@typescript-eslint/no-unnecessary-template-expression': 'off',
        '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',
      },
    },
  ]),
];
