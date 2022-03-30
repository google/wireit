# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic
Versioning](https://semver.org/spec/v2.0.0.html).

<!-- ## [Unreleased] -->

## [Unreleased]

- Limit the number of scripts running at any one time. By default it's 4 \* the
  number of CPU cores. Use the environment variable WIREIT_PARALLEL to override
  this default. Set it to Infinity to go back to unbounded parallelism.

## [0.0.0] - 2022-04-04

### Added

- Initial release.
