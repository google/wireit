module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    tsconfigRootDir: __dirname,
    project: ['./tsconfig.json', './vscode-extension/tsconfig.json'],
  },
  plugins: ['@typescript-eslint', 'no-only-tests'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
  ],
  rules: {
    'no-constant-condition': 'off',
    'no-only-tests/no-only-tests': 'error',
  },
};
