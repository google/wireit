# MVP

- Caching

  - Before running a task

    - Make the cache key (normally, except with content hashes of input files)
    - Check for "<cache-key>-manifest.json"
      - If we get a hit, that means we have output for this step cached. The
        manifest file just contains the list of output files with their content
        hashes, rather than the actual files. We separate them because it may
        turn out that we never need the actual files.
        - We apply this manifest to our virtual system (but keep track of the fact
          that the files aren't actually available yet). When we run our globs, we
          do both a filesystem glob, and iterate through our virtual files to add
          virtual matches. (Input file globs should be able to assume that the
          outputs from prior tasks are present -- though if we broke this
          assumption, then we could check for cache hits concurrently)
      - If we don't get a hit, then we need to materialize all of our transitive
        dependencies, which will trigger a recursive cascade of builds.

  - After running a task

    - Glob for the configured "output" paths
      - Save the manifest (filenames and hashes) to "<cache-key>-manifest.json",
        and the contents as "<cache-key>-output.tar" (this can happen in the
        background while we continue with other steps).

  - Notes
    - Create an abstraction which lets us do filesystem caching, or GitHub
      Action caching.
    - With local filesystem caching, if a task's output is one entire directory
      (not a glob), then we can do more efficient directory swaps (mv <current>
      <cache>/<new-hash> && mv <cache>/<old-hash> <current>)
    - The virtual filesystem idea will be useful for more efficient invalidation
      via chokidar, too.

- Watch mode should reload configs when the configs change
- Bug where we have to sleep before closing down watch mode or else we get error
- Bug where pending processes don't exit
- Test that changing the command invalidates the cache
- Test that processes are getting cleaned up
- Test that output is getting logged
- Documentation
- Usability problems
  - Typing "cmd" instead of "command" and nothing happening
  - Bug where after a failed "tsc" watch mode didn't re-run
  - Need indication about what's running
  - Forgetting the "tasks" object
  - Glob patterns that don't match any files (warn or error)
- Names
  - wireit
  - grum
  - run2
  - atr (another task runner)
  - xenomorph
  - zaatar
  - mechane
  - mecharun
  - mechabuild
  - mechascript
  - mechbuild

# Followup

- Ability to say that a task shouldn't block the next step, but still fail
  overall (tsc style).
- More efficient use of chokidar
- What happens if you run two command simultaneously
- Windows support
- Linear output mode that prevents interleaving of output
- Automatic panels (maybe using tmux)
- Progress bar
- Website
- Bash completion
- Build multiple packages (... etc. syntax)
- A way to run scripts like "wireit packages/foo:task"
- Investigate script-shell
- A way for a program to report whether it actually "ran" or not (maybe it can
  output a special string to its stdout, like in GitHub actions). Example can
  show writing a small script and using `|` to check the status.
- More advanced caching
- Better server support (e.g. how to know which inputs require reload)
- Lint this repo
- Diagnose mode: run each step with no concurrency, and check for overlapping
  output files (two tasks that both write to the same file, or whose output
  globs includes another tasks's output)
