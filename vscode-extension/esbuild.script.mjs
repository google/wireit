/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['./src/client.ts'],
  bundle: true,
  outfile: 'built/client.js',
  platform: 'node',
  minify: true,
  target: 'es2018',
  format: 'cjs',
  color: true,
  external: ['vscode'],
  mainFields: ['module', 'main'],
});

await esbuild.build({
  entryPoints: ['../src/language-server.ts'],
  bundle: true,
  outfile: 'built/server.js',
  platform: 'node',
  minify: true,
  target: 'es2018',
  format: 'cjs',
  color: true,
  mainFields: ['module', 'main'],
});
