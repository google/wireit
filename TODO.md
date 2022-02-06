# MVP

- Get rid of "tasks" layer

- Sweep all TODOs into here

- Rename "npm" to "checkNpmPackageLocks"

- Document "checkNpmPackageLocks"

- Watch mode should reload configs when the configs change

- Lint this repo

- Potential bugs

  - After a failed "tsc", watch mode didn't re-run
  - We have to sleep before closing down watch mode or else we get error
  - Bug where pending processes don't exit

- Tests

  - Test that we are killing all processes
  - Test that we display stdout/stderr
  - Test that changing the command invalidates the cache
  - Test that processes get cleaned up
  - Run CI tests on macOS

# Next

- Implement `--only-status-required`.

- More efficient use of chokidar.

- Windows support and test in CI

- Output mode that prevents interleaved output (when concurrent tasks running,
  only one can have a lock on stdout/stderr at a time).

- Usability problems

  - Typing "cmd" instead of "command" and nothing happening
  - Need indication about what's running
  - Glob patterns that don't match any files (warn or error)

- Ability to run scripts like "wireit run foo bar" or "wireit run
  packages/\*:test"

- Ability to say that a task shouldn't block the next step, but still fail
  overall (tsc style).

- A way to detect when running to wireit commands simultaneously to prevent
  clobbering.

- Daemon mode for servers. A way to say which inputs require a restart.

- Use e.g. tmux to display concurrent steps in different windows (e.g. so that
  parallel test output isn't mixed, and can be read independently)

- A way for a program to report whether it actually "ran" or not (maybe it can
  output a special string to its stdout, like in GitHub actions). Example can
  show writing a small script and using `|` to check the status.

- Diagnose mode: run each step with no concurrency, and check for overlapping
  output files (two tasks that both write to the same file, or whose output
  globs includes another tasks's output)
