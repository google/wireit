# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic
Versioning](https://semver.org/spec/v2.0.0.html).

<!-- ## Unreleased -->

## [0.14.12] - 2025-04-10

### Fixed

- Updated GitHub Actions caching to support its new v2 backend. See
  [#1297](https://github.com/google/wireit/issues/1297) and
  https://github.blog/changelog/2025-03-20-notification-of-upcoming-breaking-changes-in-github-actions/#decommissioned-cache-service-brownouts
  for background.

## [0.14.11] - 2025-02-07

### Changed

- Added `"wireit-"` prefix to GitHub Actions cache keys so that they can be identified more easily.

## [0.14.10] - 2025-01-28

### Fixed

- Fix a bug that may have resulted in Wireit attempting to open too many files
  at once (no known reports).

- When an unexpected error occurs, the specific script that failed is now
  reported by the logger, instead of the less-useful entry-point script.

- When an output file is deleted during output manifest generation, a more
  useful error message is reported instead of an unexpected error.

## [0.14.9] - 2024-09-03

### Added

- Add support for forcing the use of filesystem polling instead of OS events in watch mode. Set the environment variable `WIREIT_WATCH_STRATEGY=poll`, and optionally `WIREIT_WATCH_POLL_MS` (default `500`).

## [0.14.8] - 2024-08-22

### Added

- Added support for `node --run`, available in Node 22 and above (see
  https://nodejs.org/en/blog/announcements/v22-release-announce#running-packagejson-scripts).

## [0.14.7] - 2024-08-05

- When GitHub caching fails to initialize, more information is now shown about
  the error, and it is no longer fatal.

## [0.14.6] - 2024-08-05

### Added

- Added support for the `v2` version of the
  `google/wireit@setup-github-actions-caching` action, which provides improved
  security. All users are advised to upgrade to
  `google/wireit@setup-github-actions-caching/v2`.

## [0.14.5] - 2024-07-08

### Fixed

- Wireit will now shut down its child processes gracefully when receiving
  `SIGTERM`. Previously only `SIGINT` was listened for.

### Changed

- Updated `engines` in `package.json` so that users of Node 16 and 17 will get
  install warnings (consistent with `0.13.0` which already raised the minimum
  supported version to Node 18).

- Replaced `braces` dependency with smaller `brace-expansion` dependency.

## [0.14.4] - 2024-01-26

### Fixed

- When listing a symlink that points to a directory in `output` files, the
  symlink will now be directly cached as a symlink, instead of its children
  being cached. This also fixes an `file already exists, symlink` exception that
  could occur in the same situation.

## [0.14.3] - 2024-01-10

### Fixed

- Handle missing file errors thrown while trying to fingerprint an input file with a graceful abort.

## [0.14.2] - 2024-01-10

### Added

- Added a `default` option to the `env` setting for externally-provided environment variables to use when no value is provided.

### Changed

- The default logger for non-interactive environments has been switched to the 'quiet-ci' logger.
- The local cache strategy will now create copy-on-write files when supported. This can improve performance when copying output files either into the cache or restoring from out of it, as the files' underlying data doesn't need to be copied, only filesystem metadata.
- Unhandled exceptions will now be handled more gracefully.

## [0.14.1] - 2023-10-20

### Fixed

- Fix our `npx wireit` detection so we continue to give a good error message
  with the latest version of `npm` when wireit is run this way.

- Fix a bug where wireit would hang with an empty spinner after being killed
  with CTRL-C when running a service whose dependencies were still starting.

## [0.14.0] - 2023-09-12

### Changed

- The default logger has switched from 'simple'. It's 'quiet-ci' if the environment variable `CI` is set, otherwise it's 'quiet'. To switch back, set the environment variable WIREIT_LOGGER to 'simple'.

### Fixed

- More reliably handle and report diagnostics for scripts with invalid configurations. Specifically fixed https://github.com/google/wireit/issues/803.

- Gracefully handle errors from the GitHub download cache API.

## [0.13.0] - 2023-09-01

### Changed

- **[BREAKING]** Node 14 and Node 16 are no longer supported. Node 14 is past its end of life and Node 16 will be shortly. See the Node Release Schedule here:https://github.com/nodejs/Release#release-schedule. Node 18 will be supported until April 2025.

## [0.12.0] - 2023-09-01

## Added

- Added a `quiet-ci` logger with output optimized for non-interactive environments, like a continuous integration builder (e.g. GitHub Actions). Writes less often, doesn't show a spinner, doesn't use \r to try to writeover previous output, and only prints a new status line if there's been a change.

## Fixed

- Don't write to Symbol.dispose if it's already present, as that throws an error if there's a native implementation. This fixes wireit in Node v20.

## [0.11.0] - 2023-08-30

## Added

- The `WIREIT_LOGGER` environment variable can now be used to control the system that writes output the the command line.
- Added a new `quiet` logger that writes a single continuously updating line summarizing progress, and only passes along stdout and stderr from commands if there's a failure.

## [0.10.0] - 2023-07-10

### Added

- Added tracking of metrics for successful script executions. Metrics are emitted
  at the end of each run where at least one successful execution occurred.

- Wireit now limits its number of file descriptors. This is to prevent crashes, and the default value of 200 should be high enough not to regress performance. Set the WIREIT_MAX_OPEN_FILES env variable to override the default.

## [0.9.5] - 2023-02-06

### Changed

- Better attribute socket errors, and don't crash when a socket is closed
  unexpectedly.

### Fixed

- Fixed infinite loops that could occur in watch mode when a script failed, but
  still emitted output that was configured as the input files for another
  script.

- Don't clear the console or emit "no-op" style log messages in watch mode for
  iterations that don't do anything useful.

## [0.9.4] - 2023-01-30

### Changed

- It is now allowed to define a wireit script without a corresponding entry in
  the `scripts` section. Such scripts cannot be directly invoked with `npm run
  <script>` or similar, but they can still be used as dependencies by other
  wireit scripts.

## [0.9.3] - 2023-01-03

### Fixed

- In watch mode, watchers are no longer created for `package-lock.json` files
  that don't yet exist at the time of analysis. This saves resources, and on
  Windows should reduce errors such as
  `EBUSY: resource busy or locked, lstat 'C:\DumpStack.log.tmp`.

## [0.9.2] - 2022-12-09

### Fixed

- Fixed bug relating to services not getting shut down following an error in one
  of its dependencies.
- Fixed some cases of errors being logged multiple times.
- Errors are now consistently logged immediately when they occur, instead of
  sometimes only at the end of all execution.

## [0.9.1] - 2022-12-06

### Added

- Added `env` setting which allows either directly assigning environment
  variables, or indicating that an externally-provided environment variable
  should affect the fingerprint (and hence freshness/caching). Example:

```json
{
  "wireit": {
    "bundle:prod": {
      "command": "rollup -c",
      "files": ["lib/**/*.js", "rollup.config.js"],
      "output": ["dist/bundle.js"],
      "env": {
        "MODE": "prod",
        "DEBUG": {
          "external": true
        }
      }
    }
  }
}
```

## [0.9.0] - 2022-11-29

### Changed

- **[BREAKING]** A `watch` argument (without the `--`) is now passed to the
  script, instead of erroring, to make it consistent with all other arguments.
  (The error was previously repoted to aid in migration from `watch` to
  `--watch`, which changed in `v0.6.0).

- **[BREAKING]** The `.yarn/` folder has been added to the list of default
  excluded paths.

- It is now allowed to set the value of a wireit script to e.g.
  `"../node_modules/.bin/wireit"` if you need to directly reference a wireit
  binary in a specific location.

- `yarn.lock` and `pnpm-lock.yaml` are now automatically used as package lock
  files when yarn and pnpm are detected, respectively. (Previously
  `package-lock.json` was always used unless the `packageLocks` array was
  manually set).

### Fixed

- The `--watch` flag can now be passed to chained scripts when using yarn 1.x.
  However due to https://github.com/yarnpkg/yarn/issues/8905, extra arguments
  passed after a `--` are still not supported with yarn 1.x. Please consider
  upgrading to yarn 3.x, or switching to npm.

## [0.8.0] - 2022-11-18

### Added

- **[BREAKING]** The following folders are now excluded by default from both the
  `files` and `output` arrays:

  - `.git/`
  - `.hg/`
  - `.svn/`
  - `.wireit/`
  - `CVS/`
  - `node_modules/`

  In the highly unusual case that you need to reference a file in one of those
  folders, set `allowUsuallyExcludedPaths: true` to remove all default excludes.

### Fixed

- Fixed `Invalid string length` and `heap out of memory` errors when writing the
  fingerprint files for large script graphs.

- Fixed bug where an exclude pattern for a folder with a trailing slash would
  not be applied (e.g. `!foo` worked but `!foo/` did not).

## [0.7.3] - 2022-11-14

### Added

- Added `"service": true` setting, which is well suited for long-running
  processes like servers. A service is started either when it is invoked directly,
  or when another script that depends on it is ready to run. A service is stopped
  when all scripts that depend on it have finished, or when Wireit is exited.

- Added `"cascade": false` setting to dependencies.

  By default, the fingerprint of a script includes the fingerprints of its
  dependencies. This means a script will re-run whenever one of its dependencies
  re-runs, even if the output produced by the dependency didn't actually change.

  Now, if a dependency is annotated with `"cascade": false`, then the
  fingerprint of that dependency will no longer be included in the script's own
  fingerprint. This means a script won't neccessarily re-run just because a
  dependency re-ran — though Wireit will still always run the dependency first
  if it is not up-to-date.

  Using `"cascade": false` can result in faster builds thanks to fewer re-runs,
  but it is very important to specify all of the input files generated by the
  dependency which the script depends on in the `files` array.

  Example:

  ```json
  {
    "wireit": {
      "build": {
        "command": "tsc",
        "files": ["tsconfig.json", "src/**/*.ts"],
        "output": "lib/**",
      },
      "bundle": {
        "command": "rollup -c",
        "files": ["rollup.config.json", "lib/**/*.js", "!lib/test"],
        "output": ["dist/bundle.js"],
        "dependencies": {
          [
            "script": "build",
            "cascade": false
          ]
        }
      }
    }
  }
  ```

### Changed

- Added string length > 0 requirement to the `command`, `dependencies`, `files`,
  `output`, and `packageLocks` properties in `schema.json`.

### Fixed

- Fixed memory leak in watch mode.

- Added graceful recovery from `ECONNRESET` and other connection errors when
  using GitHub Actions caching.

- Fixed bug where a leading slash on a `files` or `output` path was incorrectly
  interpreted as relative to the filesystem root, instead of relative to the
  package, in watch mode.

## [0.7.2] - 2022-09-25

### Fixed

- Fixed issue where a redundant extra run could be triggered in watch mode when
  multiple scripts were watching the same file(s).

### Changed

- stdout color output is now forced when Wireit is run with a text terminal
  attached.

- Default number of scripts run in parallel is now 2x logical CPU cores instead
  of 4x.

## [0.7.1] - 2022-06-27

### Fixed

- 503 "Service Unavailable" HTTP errors returned by the GitHub Actions caching
  service are no longer fatal. Instead, caching will be skipped for the
  remainder of the Wireit run, similar to how 429 "Too Many Requests" errors are
  handled.

## [0.7.0] - 2022-06-17

### Removed

- [**Breaking**] stdout/stderr are no longer replayed. Only if a script is
  actually running will it now produce output to those streams.

## [0.6.1] - 2022-06-15

### Fixed

- Fix out of date files from `0.6.0`.

## [0.6.0] - 2022-06-15

### Added

- You can now pass arbitrary extra arguments to a script by setting them after a
  double-dash, e.g. `npm run build -- --verbose`.

- If you're using Yarn Berry, you can now invoke the shared instance of wireit
  at the root of your workspace from any package's `scripts` entry:

  ```json
  "scripts": {
    "build": "yarn run -TB wireit"
  },
  ```

### Fixed

- Yarn Berry now supports watch mode.

### Changed

- [**Breaking**] Watch mode is now set using `--watch` instead of `watch`, e.g.
  `npm run build --watch`. Using the old `watch` style argument will error until
  an upcoming release, at which point it will be sent to the underlying script,
  consistent with how npm usually behaves.

- Scripts are no longer skipped as fresh if any `output` files were changed,
  added, or removed since the previous run.

- In order for a script to be skipped as fresh, it is now required to specify
  the `output` files. Previously only input `files` were required.

## [0.5.0] - 2022-05-31

### Added

- It is now possible to define a script that only defines `files`. This can be
  useful for organizing groups of shared input files that multiple scripts can
  depend on, such as configuration files.

### Changed

- [**Breaking**] Setting `"output"` on a script that does not have a `"command"`
  is now an error.

- The internal `.wireit/*/state` file was renamed to `.wireit/*/fingerprint`.
  Should have no effect.

- If a script does not define a `"command"`, then fingerprints, lock files, and
  cache entries are no longer written to the `.wireit` directory. This change
  should have no user-facing effect apart from a very minor performance
  improvement.

- Analysis errors encountered in watch mode are no longer fatal. If any
  `package.json` file that was encountered in the failed analysis was modified,
  a new analysis attempt will start.

- Performance improvements to watch mode. Re-analysis of configuration now only
  occurs when a relevant `package.json` file was modified, instead of if any
  file was modified. Filesystem watchers are now re-used across iterations
  unless they are changed by a config update.

## [0.4.3] - 2022-05-15

### Changed

- Install size decreased from 25MB to 2.4MB.

- Total transitive dependencies decreased from 93 to 29.

- New GitHub Actions caching implementation. Should be a drop-in replacement.

### Fixed

- Fixed error formatting for a missing dependency in the same package
  that had a colon in its name. We were drawing the squiggle only under the
  part of the dependency name after the first colon, as though it was a
  cross-package dependency, and the part before the colon was a relative
  path.

## [0.4.2] - 2022-05-13

### Added

- Added `WIREIT_FAILURES` environment variable that controls what happens when a
  script fails (meaning it returned with a non-zero exit code) with the
  following options:

  - `no-new` (default): Allow running scripts to continue, but don't start new
    ones.
  - `continue`: Allow running scripts to continue, and start new ones as long as
    all of their dependencies succeeded.
  - `kill`: Immediately kill running scripts, and don't start new ones.

### Changed

- Default failure mode changed from `continue` to `no-new` (see above for
  definitions).

- A distinct event is now logged when a script is killed intentionally by
  Wireit.

## [0.4.1] - 2022-05-10

### Fixed

- The `Running command` log message now prints immediately before the child
  process is spawned. Previously it would print even if it was blocked by
  parallelism contention.

- Rate limit errors from GitHub Actions are no longer fatal. If it occurs, a
  message will be logged, and caching will be disabled for the remainder of the
  current Wireit process.

### Changed

- If two or more scripts depend on the same invalid config, or if they both
  depend on a script that fails, we now only log about it once.

- We continue analyzing package.json files past the first error so that we
  can show as many potential issues as we can find.

- Added an IDE analyzer interface, so that the VSCode extension can use the
  same logic as the CLI for finding diagnostics.

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

- The fingerprint now additionally includes the following fields:

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

[unreleased]: https://github.com/google/wireit/compare/v0.14.12...HEAD
[0.14.11]: https://github.com/google/wireit/compare/v0.14.11...v0.14.12
[0.14.11]: https://github.com/google/wireit/compare/v0.14.10...v0.14.11
[0.14.10]: https://github.com/google/wireit/compare/v0.14.9...v0.14.10
[0.14.9]: https://github.com/google/wireit/compare/v0.14.8...v0.14.9
[0.14.8]: https://github.com/google/wireit/compare/v0.14.7...v0.14.8
[0.14.7]: https://github.com/google/wireit/compare/v0.14.6...v0.14.7
[0.14.6]: https://github.com/google/wireit/compare/v0.14.5...v0.14.6
[0.14.5]: https://github.com/google/wireit/compare/v0.14.4...v0.14.5
[0.14.4]: https://github.com/google/wireit/compare/v0.14.3...v0.14.4
[0.14.3]: https://github.com/google/wireit/compare/v0.14.2...v0.14.3
[0.14.2]: https://github.com/google/wireit/compare/v0.14.1...v0.14.2
[0.14.1]: https://github.com/google/wireit/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/google/wireit/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/google/wireit/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/google/wireit/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/google/wireit/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/google/wireit/compare/v0.9.5...v0.10.0
[0.9.5]: https://github.com/google/wireit/compare/v0.9.4...v0.9.5
[0.9.4]: https://github.com/google/wireit/compare/v0.9.3...v0.9.4
[0.9.3]: https://github.com/google/wireit/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/google/wireit/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/google/wireit/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/google/wireit/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/google/wireit/compare/v0.7.3...v0.8.0
[0.7.3]: https://github.com/google/wireit/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/google/wireit/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/google/wireit/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/google/wireit/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/google/wireit/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/google/wireit/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/google/wireit/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/google/wireit/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/google/wireit/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/google/wireit/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/google/wireit/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/google/wireit/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/google/wireit/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/google/wireit/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/google/wireit/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/google/wireit/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/google/wireit/compare/v0.0.0...v0.1.0
[0.0.0]: https://github.com/google/wireit/releases/tag/v0.0.0
