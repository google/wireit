# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic
Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

## [0.0.0] - 2022-04-04

### Added

- Initial release.
