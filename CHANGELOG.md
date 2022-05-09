# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic
Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- If two or more scripts depend on the same invalid config, or if they both depend on a script that fails, we now only log about it once.

## [0.4.0] - 2022-05-06

### Changed

- [**Breaking**] A leading `/` on a `files` or `output` glob pattern is now
  interpreted relative to the current package directory. Previously it was
  interpreted relative to the root of the filesystem. In the case of `files`
  (but not `output`), it is still possible to reference files outside of the
  current package with a pattern like `../foo`.

- [**Breaking**] It is now an error to try and cache an `output` file that is
  not contained within the current package.

- Starting to improve error messages by drawing squiggles underneath the
  specific part of the `package.json` file that's in error.

### Fixed

- [**Breaking**] If two or more entirely separate `npm run` commands are run for
  the same Wireit script, only one of them will now be allowed to run at a time,
  while the others wait their turn. This restriction is removed if `output` is
  set to an empty array.

## [0.3.1] - 2022-04-30

### Fixed

- Fixed `replaceAll is not a function` errors when using Node 14 on Windows.

## [0.3.0] - 2022-04-29

### Changed

- The minimum Node version is now `14.14.0` instead of `16.0.0`.

## [0.2.1] - 2022-04-27

### Fixed

- Added support for running scripts with [yarn](https://classic.yarnpkg.com/),
  [pnpm](https://pnpm.io/), and older versions of npm.

## [0.2.0] - 2022-04-26

### Added

- Added support for caching on GitHub Actions. Use the
  `google/wireit@setup-github-actions-caching/v1` action to enable.

### Changed

- [**Breaking**] In the `files` array, matching a directory now matches all
  recursive contents of that directory.

- [**Breaking**] The order of `!exclude` glob patterns in the `files` and
  `output` arrays is now significant. `!exclude` patterns now only apply to the
  patterns that precede it. This allows a file or directory to be re-included
  after exclusion.

- [**Breaking**] It is now an error to include an empty string or all-whitespace
  string in any of these fields:

  - `command`
  - `dependencies`
  - `files`
  - `output`
  - `packageLocks`

- The cache key now additionally includes the following fields:

  - The system platform (e.g. `linux`, `win32`).
  - The system CPU architecture (e.g. `x64`).
  - The system Node version (e.g. `16.7.0`).

### Fixed

- Scripts now identify their own package correctly when they are members of npm
  workspaces, and they can be invoked from the root workspace using `-ws`
  commands.

- Give a clearer error message when run with an old npm version.

- When cleaning output, directories will now only be deleted if they are empty.

- When caching output, excluded files will now reliably be skipped. Previously
  they would be copied if the parent directory was also included in the `output`
  glob patterns.

- Symlinks cached to local disk are now restored with verbatim targets, instead
  of resolved targets.

## [0.1.1] - 2022-04-08

### Added

- Added `WIREIT_CACHE` environment variable, which controls caching behavior.
  Can be `local` or `none` to disable.

- Added `if-file-deleted` option to the `clean` settings. In this mode,
  `output` files are deleted if any of the input files have been deleted since
  the last run.

### Changed

- In watch mode, the terminal is now cleared at the start of each run, making it
  easier to distinguish the latest output from previous output.

- In watch mode, a "Watching for file changes" message is now logged at the end
  of each run.

- A "Restored from cache" message is now logged when output was restored from
  cache.

- Caching is now disabled by default when the `CI` environment variable is
  `true`. This variable is automatically set by GitHub Actions and Travis. The
  `WIREIT_CACHE` environment variable takes precedence over this default.

## [0.1.0] - 2022-04-06

### Added

- Limit the number of scripts running at any one time. By default it's 4 \* the
  number of CPU cores. Use the environment variable WIREIT_PARALLEL to override
  this default. Set it to Infinity to go back to unbounded parallelism.

- Added local disk caching. If a script has both its `files` and `output` arrays
  defined, then the `output` files for each run will now be cached inside the
  `.wireit` directory. If a script runs with the same configuration and `files`,
  then the `output` files will be copied from the cache, instead of running the
  script's command.

### Changed

- [**Breaking**] Bumped minimum Node version from `16.0.0` to `16.7.0` in order
  to use `fs.cp`.

### Fixed

- Fixed bug where deleting a file would not trigger a re-run in watch mode.

- Fixed bug which caused `node_modules/` binaries to not be found when crossing
  package boundaries through dependencies.

## [0.0.0] - 2022-04-04

### Added

- Initial release.
