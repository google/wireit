# MVP

- GitHub Actions various bad implementation details.

- Document how it works with NPM workspaces

- Can scripts start with "." or ":." etc.? How to escape.

- Potential bugs

  - After a failed "tsc", watch mode doesn't re-run
  - tsc gets stalled, and ctrl-C doesn't work
  - We have to sleep before closing down watch mode or else we get error
  - Bug where pending processes don't exit
  - Bug when running task after "cd" command. Something to do with npm
    environment variable.
  - Bug where failure in github caching silently exits
  - GitHub actions is reporting success, even though script failed with
    exception!

- Save sha256 instead of entire JSON in state

- Don't make hash dependent on script name, so that scripts can be renamed
  without dropping cache hits?

- Rename state to fresh

- State needs to know that we're in a failed state, or else it could have
  partial failed output from one run, but we'll think it's good to go from the
  previous state that was successful!

- Does the globbing behavior of chokidar and fast-glob match?

- Don't cache (or freshness check?) when no output files

- Watch mode doesn't need to hash the package locks, just get their filenames.

- Don't freshness check when no input files

- Handle "close" vs "exit" and "error" events when spawning.

- Watch mode should reload configs when the configs change

- Nicer error output messages

- Empty/clean output directories when defined.

- Find places that could be more concurent, like writing caches

- How to deal with symlinks in caching

- Check that we stay within the package directory in caching. Should it be
  possible to reach outside somehow?

- Lint this repo

- Tests

  - Test that we are killing all processes
  - Test that we display stdout/stderr
  - Test that changing the command invalidates the cache
  - Test that processes get cleaned up
  - Tests for missing script
  - Test that chokidar works with empty globs.
  - Run CI tests on macOS

# Next

- Implement `--only-status-required`.

- More efficient use of chokidar.

- Are all NPM package script names safe to put in the .wireit folder? Need
  escaping?

- Test with a known good version so that we don't have to bootstrap.

- Integrate crazy-max/ghaction-github-runtime solution for getting variables.

- `--parallelism` or `--concurrency` flag

- Control over whether `watch` mode restarts on changes, or waits for the
  current build to end. Also a keyboard shortcut like `R` to force a restart.

- Does it make sense to add a `caching:false` option? E.g. tasks that are faster
  to run than cache? But how does that interact with `--only-status-required`
  mode?

- Windows support and test in CI

- How to deal with permission bits in file hash key.

- Error if a script is missing a command.

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
