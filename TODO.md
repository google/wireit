# MVP

## Bugs

- Bug where pending processes don't exit
- Bug when running task after "cd" command. Something to do with npm environment
  variable.

## Features

- Watch mode should reload configs when the configs change
- Implement $WORKSPACE_DEPS
- Nicer error output messages
- A keyboard shortcut like `R` to force a restart in watch mode, for when not
  using --interrupt.
- Ability to say that a script shouldn't block the next step, but still fail
  overall (tsc style).
- Ability to pass args directly to commands. Must be included in cache key.
- Output mode that prevents interleaved output (when concurrent scripts running,
  only one can have a lock on stdout/stderr at a time).
- Ability to configure environment variables that are significant.
- Add clean command
- Add dry run mode

## Open questions

- How to deal with .tsbuildinfo files. Should they be inputs? Maybe we mark
  deleteOutputBeforeEachRun:false?
- Should we only parallelize contiguous blocks of wireit scripts when using
  $WORKSPACES?
- Can scripts start with "." or ":." etc.? How to escape.
- Be careful with automatic deletion! It could easily delete way too much.
- Should --parallel default to num CPU cores?
- Does the globbing behavior of chokidar and fast-glob match?
- Are we handling "close" vs "exit" and "error" events correctly when spawning?
- How to deal with symlinks in caching
- Check that we stay within the package directory in caching. Should it be
  possible to reach outside somehow?
- GitHub Actions salt to force cache bust
- What does watch mode do with undefined or empty files? Maybe it should default
  to all files in the package?
- How to deal with permission bits in file hash key.
- Are all NPM package script names safe to put in the .wireit folder? Need
  escaping?

## Refactoring

- Handling of $WORKSPACES is incredibly inefficient.
- Argument parsing is bad
- GitHub Actions various bad implementation details
- Save sha256 instead of entire JSON in state
- Don't make hash dependent on script name, so that scripts can be renamed
  without dropping cache hits?
- Watch mode doesn't need to hash the package locks, just get their filenames.
- Rename state to fresh
- Find places that could be more concurent, like writing caches
- Lint this repo
- More efficient use of chokidar.
- Replace chokidar with something simpler?

## Tests

- CI was showing success even on failure?
- Add test that we become fresh after restoring from cache.
- We have to sleep before closing down watch mode or else we get error. What's
  up with that?
- Test that we are killing all processes
- Test that we display stdout/stderr
- Test that changing the command invalidates the cache
- Test that processes get cleaned up
- Tests for missing script
- Test that chokidar works with empty globs.
- Run CI tests on macOS
- Windows support and test in CI
- Test with a known good version on CI so that we don't have to bootstrap.

# Next

- Daemon mode for servers. A way to say which inputs require a restart.

- A way to detect when running to wireit commands simultaneously to prevent
  clobbering. Useful for lerna?

- An `--only-status-required` or similar mode, which could be faster in CI, by
  only downloading manifest tarballs, instead of full output tarballs, when
  possible.

- Write output to file descriptors keyed by task name. Now in watch mode,
  somebody can do `tail -f .wireit/stdout/ts` to see the output of that script
  live. If you then run the same script in two different terminals, could we
  just detect that one is already running, and tail its output? That way you
  could do `npm run build -- watch` in one terminal and `npm run ts -- watch` in
  another, in case you want to see the output of ts in a separate window --- but
  without the two stepping on each other.

- Integrate crazy-max/ghaction-github-runtime solution for getting variables.

- Does it make sense to add a `caching:false` option? E.g. tasks that are faster
  to run than cache? But how does that interact with `--only-status-required`
  mode?

- Usability problems

  - Typing "cmd" instead of "command" and nothing happening
  - Need indication about what's running
  - Glob patterns that don't match any files (warn or error)

- Progress bars and other nice console output? Should be optional.

- Ability to configure arbitrary commands that are significant for caching.

- Ability to run scripts like "wireit run foo bar" or "wireit run
  packages/\*:test"

- Ability to set a custom `watch` command, along with `start`, `succeed` and
  `fail` regular expressions. When set, watch mode launches this command, and
  checks its stdout/stderr for those regexps to determine the status. This could
  be much faster for e.g. repeated tsc builds. Need to think about what happens
  when a dependency changes -- kill the watchers if a dependency changes, so
  that we don't get partial runs? Also need to think about how to combine
  multiple `tsc` invocations that are already linked through `--composite` mode.

- Use e.g. tmux to display concurrent steps in different windows (e.g. so that
  parallel test output isn't mixed, and can be read independently)

- A way for a program to report whether it actually "ran" or not (maybe it can
  output a special string to its stdout, like in GitHub actions). Example can
  show writing a small script and using `|` to check the status.

- Diagnose mode: run each step with no parallelism, and check for overlapping
  output files (two script that both write to the same file, or whose output
  globs includes another script's output)

- Store the current npm install state. Add a "postinstall" script to each
  package, which does "sha256sum package-lock.json > .wireit/npm-install-state"
  or similar (probably also want to include the "dependencies" and
  "devDependencies" field of package.json, also consider yarn). Now whenever
  wireit runs, it could check that you are fresh and error.
