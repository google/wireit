---
layout: layout.njk
title: Reference
permalink: reference/index.html
eleventyNavigation:
  key: Reference
  order: 12
---

## Reference

### Configuration

The following properties can be set inside `wireit.<script>` objects in
`package.json` files:

| Property       | Type                           | Default                 | Description                                                                                                |
| -------------- | ------------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `command`      | `string`                       | `undefined`             | The shell command to run.                                                                                  |
| `dependencies` | `string[]`                     | `undefined`             | [Scripts that must run before this one](../dependencies/).                                                 |
| `files`        | `string[]`                     | `undefined`             | Input file [glob patterns](#glob-patterns), used to determine the [cache key](#cache-key).                 |
| `output`       | `string[]`                     | `undefined`             | Output file [glob patterns](#glob-patterns), used for [caching](../caching/) and [cleaning](../cleaning/). |
| `clean`        | `boolean \| "if-file-deleted"` | `true`                  | [Delete output files before running](../cleaning/).                                                        |
| `packageLocks` | `string[]`                     | `['package-lock.json']` | [Names of package lock files](../package-locks/).                                                          |

### Dependency syntax

The following syntaxes can be used in the `wireit.<script>.dependencies` array:

| Example      | Description                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| `foo`        | Script named `"foo"` in the same package.                                                                       |
| `../foo:bar` | Script named `"bar"` in the package found at `../foo` ([details](../dependencies/#cross-package-dependencies)). |

### Environment variables

The following environment variables affect the behavior of Wireit:

| Variable          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WIREIT_PARALLEL` | [Maximum number of scripts to run at one time](../parallelism/).<br><br>Defaults to 4×CPUs.<br><br>Must be a positive integer or `infinity`.                                                                                                                                                                                                                                                                                                                             |
| `WIREIT_CACHE`    | [Caching mode](../caching/).<br><br>Defaults to `local` unless `CI` is `true`, in which case defaults to `none`.<br><br>Automatically set to `github` by the [`google/wireit@setup-github-actions-caching/v1`](../caching/#github-actions-caching) action.<br><br>Options:<ul><li>[`local`](../caching/#local-caching): Cache to local disk.</li><li>[`github`](../caching/#github-actions-caching): Cache to GitHub Actions.</li><li>`none`: Disable caching.</li></ul> |
| `CI`              | Affects the default value of `WIREIT_CACHE`.<br><br>Automatically set to `true` by [GitHub Actions](https://docs.github.com/en/actions/learn-github-actions/environment-variables#default-environment-variables) and most other CI (continuous integration) services.<br><br>Must be exactly `true`. If unset or any other value, interpreted as `false`.                                                                                                                |

### Glob patterns

The following glob syntaxes are supported in the `files` and `output` arrays:

| Example         | Description                                                                              |
| --------------- | ---------------------------------------------------------------------------------------- |
| `foo`           | The file named `foo`, or if `foo` is a directory, all recursive children of `foo`.       |
| `foo/*.js`      | All files directly in the `foo/` directory which end in `.js`.                           |
| `foo/**/*.js`   | All files in the `foo/` directory, and all recursive subdirectories, which end in `.js`. |
| `foo.{html,js}` | Files named `foo.html` or `foo.js`.                                                      |
| `!foo`          | Exclude the file or directory `foo` from previous matches.                               |

Also note these details:

- Paths should always use `/` (forward-slash) delimiters, even on Windows.
- Paths are interpreted relative to the current package even if there is a
  leading `/` (e.g. `/foo` is the same as `foo`).
- Whenever a directory is matched, all recursive children of that directory are
  included.
- `files` are allowed to reach outside of the current package using e.g.
  `../foo`. `output` files cannot reference files outside of the current
  package.
- Symlinks in input `files` are followed, so that they are identified by their content.
- Symlinks in `output` files are cached as symlinks, so that restoring from
  cache doesn't create unnecessary copies.
- The order of `!exclude` patterns is significant.
- Hidden/dot files are matched by `*` and `**`.
- Patterns are case-sensitive (if supported by the filesystem).

### Cache key

The following inputs determine the _cache key_ for a script. This key is used to
determine whether a script can be skipped for [incremental
build](../incremental-build/), and whether its output can be [restored from
cache](../caching/).

- The `command` setting.
- The `clean` setting.
- The `output` glob patterns.
- The SHA256 content hashes of all files matching `files`.
- The SHA256 content hashes of all files matching `packageLocks` in the current
  package and all parent directories.
- The system platform (e.g. `linux`, `win32`).
- The system CPU architecture (e.g. `x64`).
- The system Node version (e.g. `16.7.0`).
- The cache key of all transitive dependencies.

When using [GitHub Actions caching](../caching/#github-actions-caching), the following
input also affects the cache key:

- The `ImageOS` environment variable (e.g. `ubuntu20`, `macos11`).
