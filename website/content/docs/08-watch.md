---
layout: docs.njk
title: Watch
permalink: docs/watch/index.html
eleventyNavigation:
  key: Watch
  order: 8
---

## Watch mode

In _watch_ mode, Wireit monitors all `files` of a script, and all `files` of its
transitive dependencies, and when there is a change, it re-runs only the
affected scripts. To enable watch mode, ensure that the
[`files`](../files/) array is defined, and add the `watch`
argument:

```bash
npm run <script> watch
```

The benefit of Wireit's watch mode over built-in watch modes are:

- Wireit watches the entire dependency graph, so a single watch command replaces
  many built-in ones.
- It prevents problems that can occur when running many separate watch commands
  simultaneously, such as build steps being triggered before all preceding steps
  have finished.
