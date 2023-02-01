---
layout: docs.njk
title: Incremental build
permalink: docs/incremental-build/index.html
eleventyNavigation:
  key: Incremental build
  order: 5
---

## Incremental build

Wireit can automatically skip execution of a script if nothing has changed that
would cause it to produce different output since the last time it ran. This is
called _incremental build_.

To enable incremental build, configure the input files for each script by
specifying [glob patterns](#glob-patterns) in the `wireit.<script>.files` list.

> ℹ️ If a script doesn't have a `files` list defined at all, then it will _always_
> run, because Wireit doesn't know which files to check for changes. To tell
> Wireit it is safe to skip execution of a script that definitely has no input
> files, set `files` to an empty array (`files: []`).
