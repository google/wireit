---
layout: docs.njk
title: Failures
permalink: docs/failures/index.html
eleventyNavigation:
  key: Failures
  order: 9
---

## Failures

By default, when a script fails (meaning it returned with a non-zero exit code),
all scripts that are already running are allowed to finish, but new scripts are
not started.

In some situations a different behavior may be better suited. There is an
additional mode, which you can set with the `WIREIT_FAILURES` environment
variable. Note that Wireit always ultimately exits with a non-zero exit code if
there was a failure, regardless of the mode.

### Continue

When a failure occurs in `continue` mode, running scripts continue, and new
scripts are started as long as the failure did not affect their dependencies.
This mode is useful if you want a complete picture of which scripts are
succeeding and which are failing.

```bash
WIREIT_FAILURES=continue
```
