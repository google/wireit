import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['./src/client.ts'],
  bundle: true,
  outfile: 'client.js',
  platform: 'node',
  minify: true,
  target: 'es2017',
  format: 'cjs',
  color: true,
  external: ['vscode'],
  mainFields: ['module', 'main'],
});

await esbuild.build({
  entryPoints: ['./src/server.ts'],
  bundle: true,
  outfile: 'server.js',
  platform: 'node',
  minify: false,
  target: 'es2017',
  format: 'cjs',
  color: true,
  mainFields: ['module', 'main'],
});
