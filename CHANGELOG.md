# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic
Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.3] - 2025-04-10

### Added

- Added `ACTIONS_RESULTS_URL` environment variable which is required for V2
  of the GitHub cache service.

## [2.0.2] - 2024-08-22

### Fixed

- Fixes occasional `no such file or directory` error at startup (a race
  condition relating to log files).

## [2.0.1] - 2024-08-12

### Fixed

- Fixes Windows support by allowing the "custodian" HTTP server to persist after
  the setup action has completed.

### Changed

- Custodian server now listens only on localhost instead of all hosts (should
  have no effect).

## [2.0.0] - 2024-08-02

### Changed

- Security improvement. The `GITHUB_ACTIONS_TOKEN` environment variable is no
  longer exported. A "custodian" HTTP server is used instead.

- Updated Node version from `16` to `20`.

## [1.0.1] - 2022-04-26

### Fixed

- Fixed invalid escaping in action YAML file.

## [1.0.0] - 2022-04-18

### Added

- Initial support for Wireit caching on GitHub Actions.

[unreleased]: https://github.com/google/wireit/compare/setup-github-actions-caching/v2.0.3...setup-github-actions-caching
[2.0.3]: https://github.com/google/wireit/compare/setup-github-actions-caching/v2.0.2...setup-github-actions-caching/v2.0.3
[2.0.2]: https://github.com/google/wireit/compare/setup-github-actions-caching/v2.0.1...setup-github-actions-caching/v2.0.2
[2.0.1]: https://github.com/google/wireit/compare/setup-github-actions-caching/v2.0.0...setup-github-actions-caching/v2.0.1
[2.0.0]: https://github.com/google/wireit/compare/setup-github-actions-caching/v1.0.1...setup-github-actions-caching/v2.0.0
[1.0.1]: https://github.com/google/wireit/compare/setup-github-actions-caching/v1.0.0...setup-github-actions-caching/v1.0.1
[1.0.0]: https://github.com/google/wireit/releases/tag/setup-github-actions-caching/v1.0.0
