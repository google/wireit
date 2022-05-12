---
layout: layout.njk
title: Recipes
permalink: recipes/index.html
eleventyNavigation:
  key: Recipes
  order: 11
---

## Recipes

This section contains advice about integrating specific build tools with Wireit.

### TypeScript

```json
{
  "scripts": {
    "ts": "wireit"
  },
  "wireit": {
    "ts": {
      "command": "tsc --build --pretty",
      "clean": "if-file-deleted",
      "files": ["src/**/*.ts", "tsconfig.json"],
      "output": ["lib/**", ".tsbuildinfo"]
    }
  }
}
```

- Set [`"incremental": true`](https://www.typescriptlang.org/tsconfig#incremental) and use
  [`--build`](https://www.typescriptlang.org/docs/handbook/project-references.html#build-mode-for-typescript)
  to enable incremental compilation, which significantly improves performance.
- Include
  [`.tsbuildinfo`](https://www.typescriptlang.org/tsconfig#tsBuildInfoFile) in
  `output` so that it is reset on clean builds. Otherwise `tsc` will get out of
  sync and produce incorrect output.
- Set [`"clean": "if-file-deleted"`](../cleaning/) so that you get fast
  incremental compilation when sources are changed/added, but also stale outputs
  are cleaned up when a source is deleted (`tsc` does not clean up stale outputs
  by itself).
- Include `tsconfig.json` in `files` so that changing your configuration re-runs
  `tsc`.
- Use [`--pretty`](https://www.typescriptlang.org/tsconfig#pretty) to get
  colorful output despite not being attached to a TTY.

### ESLint

```json
{
  "scripts": {
    "lint": "wireit"
  },
  "wireit": {
    "lint": {
      "command": "eslint --color --cache --cache-location .eslintcache .",
      "files": ["src/**/*.ts", ".eslintignore", ".eslintrc.cjs"],
      "output": []
    }
  }
}
```

- Use
  [`--cache`](https://eslint.org/docs/user-guide/command-line-interface#caching)
  so that `eslint` only lints the files that were added or changed since the
  last run, which significantly improves performance.
- Use
  [`--color`](https://eslint.org/docs/user-guide/command-line-interface#--color---no-color)
  to get colorful output despite not being attached to a TTY.
- Include config and ignore files in `files` so that changing your configuration
  re-runs `eslint`.
