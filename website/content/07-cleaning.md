---
layout: layout.njk
title: Cleaning
permalink: cleaning/index.html
eleventyNavigation:
  key: Cleaning
  order: 7
---

## Cleaning output

Wireit can automatically delete output files from previous runs before executing
a script. This is helpful for ensuring that every build is clean and free from
outdated files created in previous runs from source files that have since been
removed.

Cleaning is enabled by default as long as the
[`output`](../files/) array is defined. To change this behavior,
set the `wireit.<script>.clean` property to one of these values:

| Setting             | Description                                                                                                                                                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `true`              | Clean before every run (the default).                                                                                                                                                                                                                                                                      |
| `"if-file-deleted"` | Clean only if an input file has been deleted since the last run.<br><br>Use this option for tools that have incremental build support, but do not clean up outdated output when a source file has been deleted, such as `tsc --build` (see [TypeScript](../recipes/#typescript) for more on this example.) |
| `false`             | Do not clean.<br><br>Only use this option if you are certain that the script command itself already takes care of removing outdated files from previous runs.                                                                                                                                              |
