# MVP

- Sweep all TODOs into here

- Document how it works with NPM workspaces

- Potential bugs

  - After a failed "tsc", watch mode doesn't re-run
  - tsc gets stalled, and ctrl-C doesn't work
  - We have to sleep before closing down watch mode or else we get error
  - Bug where pending processes don't exit
  - Bug when running task after "cd" command. Something to do with npm
    environment variable.

- Include output files in cache key

- Save sha256 instead of entire JSON in state

- Rename state to fresh

- Does the globbing behavior of chokidar and fast-glob match?

- Don't cache (or freshness check?) when no output files

- Don't freshness check when no input files

- Watch mode should reload configs when the configs change

- Nicer error output messages

- Find places that could be more concurent, like writing caches

- Lint this repo

- Tests

  - Test that we are killing all processes
  - Test that we display stdout/stderr
  - Test that changing the command invalidates the cache
  - Test that processes get cleaned up
  - Tests for missing script
  - Run CI tests on macOS

# Next

- Implement `--only-status-required`.

- More efficient use of chokidar.

- Are all NPM package script names safe to put in the .wireit folder? Need
  escaping?

- `--parallelism` or `--concurrency` flag

- Control over whether `watch` mode restarts on changes, or waits for the
  current build to end. Also a keyboard shortcut like `R` to force a restart.

- Does it make sense to add a `caching:false` option? E.g. tasks that are faster
  to run than cache? But how does that interact with `--only-status-required`
  mode?

- Windows support and test in CI

- Output mode that prevents interleaved output (when concurrent scripts running,
  only one can have a lock on stdout/stderr at a time).

- Usability problems

  - Typing "cmd" instead of "command" and nothing happening
  - Need indication about what's running
  - Glob patterns that don't match any files (warn or error)

- Progress bars and other nice console output? Should be optional.

- Ability to pass args directly to commands. Must be included in cache key.

- Ability to configure environment variables that are significant.

- Ability to configure arbitrary commands that is significant for caching.

- Ability to run scripts like "wireit run foo bar" or "wireit run
  packages/\*:test"

- Ability to say that a script shouldn't block the next step, but still fail
  overall (tsc style).

- A way to detect when running to wireit commands simultaneously to prevent
  clobbering.

- Daemon mode for servers. A way to say which inputs require a restart.

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

- Diagnose mode: run each step with no concurrency, and check for overlapping
  output files (two script that both write to the same file, or whose output
  globs includes another script's output)
