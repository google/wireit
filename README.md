## wireit

## TODO

- Run commands with `npm exec`
- CTRL-C seems to be caching too aggressively (task didn't actually finish).
- Set up linting
- Tests
- Ability to run multiple tasks `wireit run packages/*:foo`
- Watch mode for servers
- Caching (probably skip this)
- Plugin interface
- A way for a program to report whether it actually "ran" or not (maybe it can
  output a special string to its stdout, like in GitHub actions). Example can
  show writing a small script and using `|` to check the status.
- Finish README

## Dependencies

- [`fast-glob`](https://github.com/mrmlnc/fast-glob) for matching file paths
- [`chokidar`](https://github.com/paulmillr/chokidar) for watching the filesystem

## Motivation

NPM package build configurations can get pretty complicated. Here's an example
of a website that uses TypeScript, Rollup, Eleventy, and Rust. Setups like this
are very common!

```json
{
  "scripts": {
    "build": "npm run build:ts && npm run build:rollup && npm run build:eleventy && npm run build:rust",
    "build:watch": "npm run build:ts:watch & npm run build:rollup:watch & npm run build:eleventy:watch & npm run build:rust:watch",
    "build:ts": "tsc",
    "build:ts:watch": "tsc --watch",
    "build:rollup": "rollup -c",
    "build:rollup:watch": "rollup -c --watch",
    "build:eleventy": "eleventy",
    "build:eleventy:watch": "eleventy --watch",
    "build:rust": "cargo -p my-server",
    "build:rust:watch": "nodemon --watch 'server/**/*.rs' --exec cargo -p my-server"
  }
}
```

What's wrong with this picture?

- All of the steps in `build` run in serial, even though some of them could run
  in parallel.

- Incremental building is hit-and-miss. If you only changed some Rust code, then
  there's no reason to run Eleventy, Rollup, or TypeScript again. Some tools
  have built-in incremental compilation support, but most don't!

- Our `:watch` scripts don't coordinate well. Rollup might trigger before
  TypeScript finishes writing all of its output, causing Rollup to unnecessarily
  trigger twice. And Rust doesn't include it's own watch mode, so we have to use
  a third-party watch tool. Also, some tool's built-in watch modes don't
  automatically restart themselves when their own config file changes.

- Too much mental overhead. I either have to build everything every time, or
  frequently switch between different commands depending on which files I am
  changing.

- There's a hidden dependency that we didn't even account for! This example is a
  monorepo, and our TypeScript code depends on another package from the same
  monorepo.

Wireit solves all of these problems. By specifying which files and other tasks a
task depends on, all of the commands we had before can be replaced by `npm run build` and `npm run build:watch`.

```json
{
  "scripts": {
    "build": "wireit",
    "build:watch": "wireit watch build",
  },
  "wireit": {
    "tasks": {
      "build": {
        "dependencies": [
          "eleventy",
          "rollup",
          "rust"
        ]
      },
      "eleventy": {
        "command": "eleventy",
        "files": [
          "site/**/*",
          "eleventy.config.js"
        ],
        "output": [
          "_site/**/*"
        ]
      },
      "rollup": {
        "command": "rollup -c",
        "dependencies": {
          "ts"
        },
        "files": [
          "rollup.config.js"
        ],
        "output": [
          "js/**/*"
        ]
      },
      "ts": {
        "command": "tsc",
        "dependencies": {
          "../another-package:build"
        },
        "files": [
          "src/**/*.ts",
          "tsconfig.json"
        ],
        "output": [
          "lib/**/*"
        ]
      },
      "rust": {
        "command": "cargo -p my-server",
        "files": [
          "server/**/*.rs"
        ]
      }
    }
  }
}
```

- Use your cores more effectively! Eleventy, Rollup, and Rust now build in
  parallel, but TypeScript still runs before Rollup.

- Incrementally build everything! `npm run build` now only runs the tasks that
  need to change. For example, if you change a TypeScript file, then `tsc` and
  `rollup` will run, but `eleventy` and `rust` won't.

- Watch everything with no races! `npm run build:watch` monitors all of the
  input files for the build, and triggers only the tasks that need to run. But
  if one task depends on another, it will wait for the first task to finish
  completely before the next one starts.

## Philosophy

### Commands, not plugins

Many build systems require installing plugins to integrate with each of the
build tools you use. Plugins can get out of date, omit features you need,
contain bugs, and add bloat to your package.

Wireit follows the UNIX philosophy: make each program do one thing well, and
write programs that work together. Wireit tasks are like NPM scripts, but just a
little smarter because they know what other tasks need to run first, and they
only run when they need to.

### Harmony with NPM scripts

Wireit doesn't make you replace your `npm run` workflows with an alternative
task runner frontend. Instead, you can incrementally upgrade your existing NPM
scripts into wireit tasks, and make the same command a little smarter. And if
you're using a monorepo, you don't need to remember to run your commands from
the root; just run them directly from the sub-package.

## Tasks

To convert an existing NPM script into a wireit script, set
`wireit.tasks.<TASKNAME>.command` in your `package.json` to the script
command, and then replace the script command with `wireit`. For example:

Before:

```json
{
  "scripts": {
    "build": "tsc"
  }
}
```

After:

```json
{
  "scripts": {
    "build": "wireit"
  },
  "wireit": {
    "tasks": {
      "build": {
        "command": "tsc"
      }
    }
  }
}
```

Now when you run `npm run build`, wireit will handle execution of the `build`
script. wireit uses the
[`$npm_lifecycle_event`](https://docs.npmjs.com/cli/v8/using-npm/scripts#current-lifecycle-event)
environment variable to determine which NPM script you ran, and automatically
matches it to the wireit task with the same name.

## Dependencies

The `dependencies` property tells wireit which tasks must complete before the
current one.

For example, when we add a `bundle` script, we should declare that `build`
should always run before it, because the output of `tsc` is the input to
`rollup`:

<!-- prettier-ignore-start -->
```json
{
  "scripts": {
    "build": "wireit",
    "bundle": "wireit"
  },
  "wireit": {
    "tasks": {
      "build": {
        "command": "tsc"
      },
      "bundle": {
        "command": "rollup -c",
        "dependencies": [
          "build"
        ]
      }
    }
  }
}
```
<!-- prettier-ignore-end -->

Now when we run `npm run bundle`, wireit will automatically run `build` first.

## Files

A file tells wireit that some files on disk are an input to that task.

For example, we can tell wireit that `tsc` depends on our TypeScript files
and its config file, and also that `rollup` depends on its own config file:

<!-- prettier-ignore-start -->
```json
{
  "scripts": {
    "build": "wireit",
    "bundle": "wireit"
  },
  "wireit": {
    "tasks": {
      "build": {
        "command": "tsc",
        "files": [
          "src/**/*.ts",
          "tsconfig.json"
        ]
      },
      "bundle": {
        "command": "rollup -c",
        "dependencies": [
          "build",
        ],
        "files": [
          "rollup.config.js"
        ]
      }
    }
  }
}
```
<!-- prettier-ignore-end -->

Now, the `bundle` task will only run if either the `build` task ran, _or_ if the
`rollup.config.js` file has changed, since the last time `bundle` ran. And the
`build` task will only run if any of the `.ts` files in the `src` directory or
the `tsconfig.json` file have changed since the last time it ran.

## Environment variables

Sometimes the behavior of a task depends on the value of an environment
variable.

For example, our Rollup config might check a variable called `MINIFY` to decide
whether to minify the output code. Including `env:MINIFY` in the dependencies
tells wireit that if the `MINIFY` envirionment variable has changed since the
last run, then it will need to be run again:

<!-- prettier-ignore-start -->
```json
{
  "scripts": {
    "bundle": "wireit"
  },
  "wireit": {
    "tasks": {
      "bundle": {
        "command": "rollup -c",
        "env": [
          "MINIFY",
        ],
        "files": [
          "rollup.config.js"
        ]
      }
    }
  }
}
```
<!-- prettier-ignore-end -->

## Missing and empty dependencies

If a task doesn't have a `dependencies`, `files`, or `env` property set at all,
then the task will _always_ run. wireit is designed this way so that if you
forget to add dependencies, or haven't figured out what they are yet, you'll get
the safer option of always running the task.

If a task has a `dependencies` property, but it is an empty array (`[]`), then
the task will only ever run once.

(To help understand this distinction, think of the missing case as saying "My
dependencies are undefined, so they could be anything and I should always run",
and the empty case as saying "I guarantee that I have zero dependencies, so I
always produce the same output and only ever need to run once").

## Reset

Run `wireit reset` to reset all of the data about recent task executions,
forcing all tasks to execute again.

If you find yourself needing this command, you might be missing a dependency!

## Cross package dependencies

By default, when you declare a task dependency, wireit will look for a task
by that name in the same `package.json` file.

Task dependencies can also reach out of the current package and invoke a task
defined in another `package.json` file. To do this, prefix the task name with
the path to the package followed by a `:`.

For example, if we're a package in a monorepo, and we import a module from
another package in the same monorepo, then we'll want to ensure that whenever we
build our package, the package we depend on is also freshly built:

<!-- prettier-ignore-start -->
```json
{
  "scripts": {
    "build": "wireit"
  },
  "wireit": {
    "tasks": {
      "build": {
        "command": "tsc",
        "dependencies": [
          "../some-other-package:build",
        ],
        "files": [
          "src/**/*.ts",
          "tsconfig.json"
        ]
      }
    }
  }
}
```
<!-- prettier-ignore-end -->

The same goes for file targets. For example, it is common to base one
`tsconfig.json` on another one:

<!-- prettier-ignore-start -->
```json
{
  "scripts": {
    "build": "wireit"
  },
  "wireit": {
    "tasks": {
      "build": {
        "command": "tsc",
        "files": [
          "src/**/*.ts",
          "tsconfig.json",
          "../../tsconfig.base.json"
        ]
      }
    }
  }
}
```
<!-- prettier-ignore-end -->

## NPM dependencies

By default, wireit automatically considers all of the NPM dependencies that
are reachable from a package as dependencies of all tasks in that package.

This is the case because tasks frequently depend on NPM dependencies, and
installing, removing, or upgrading an NPM dependency can change the behavior of
tasks that depend on them.

Specifically, wireit checks:

1. The modification time of the `package-lock.json` file.
2. The `dependencies` and `devDependencies` fields in the `package.json` file.
3. [1] and [2] for all parent directories, recursively.

If you have a task that you're sure doesn't depend on `node_modules/`, then you
can remove this automatic dependency by setting `"npm": false`. This will
prevent this task from running needlessly every time you change your NPM
dependencies.

For example:

<!-- prettier-ignore-start -->
```json
{
  "scripts": {
    "foo": "wireit"
  },
  "wireit": {
    "tasks": {
      "foo": {
        "command": "command that doesn't depend on node_modules",
        "npm": false
      }
    }
  }
}
```
<!-- prettier-ignore-end -->

## Watch mode

wireit includes a built-in watch mode which will continuously execute tasks
whenever their dependencies change.

If you are running tasks with `npm run <task>`, then append `-- --watch`. Note
the extra `--` is needed because that's how you tell `npm run` to forward
arguments to the script's program.

```sh
npm run build -- --watch
```

You can also use the `wireit` runner directly by using the `watch` command:

```sh
npx wireit watch build
```

You may prefer to define a dedicated script for this purpose:

<!-- prettier-ignore-start -->
```json
{
  "scripts": {
    "build": "wireit",
    "build:watch": "wireit watch build"
  },
  "wireit": {
    "tasks": {
      "build": {
        "command": "tsc",
        "files": [
          "src/**/*.ts",
          "tsconfig.json"
        ]
      },
    }
  }
}
```
<!-- prettier-ignore-end -->

## Daemon tasks

Some tasks are not expected to exit immediately, such as a server. wireit can
help with these kinds of commands too. Setting `"daemon": true` on a task does
the following:

1. wireit will not wait for the task to exit.
2. If a dependency changes, then the process will be restarted.
3. No task can depend on a daemon task.

In this example, the `serve` command depends on a `.js` file that is built by
`tsc`. Whenever the

<!-- prettier-ignore-start -->
```json
{
  "scripts": {
    "serve": "wireit",
    "build": "wireit"
  },
  "wireit": {
    "tasks": {
      "serve": {
        "command": "node lib/server.js",
        "daemon": true,
        "dependencies": [
          "tsc"
        ]
      },
      "build": {
        "command": "tsc",
        "files": [
          "src/**/*.ts",
          "tsconfig.json"
        ]
      },
    }
  }
}
```
<!-- prettier-ignore-end -->

## Failure modes

By default, wireit will immediately stop execution when any task process
returns with a non-zero exit code.

This behavior is controlled by the `fail` setting, which is set to `immediately`
by default.

Occasionally it is useful to continue execution even in the case of a failure,
while still failing the overall build. Setting `fail` to `eventually` enables
this behavior.

For example, if `tsc` encounters a type error, it will report the error and fail
-- but it will still emit JavaScript. In this case it can be useful to allow
subsequent tasks to continue, because while the overall build should fail, we
may still want to inspect or execute the results of the full build graph:

<!-- prettier-ignore-start -->
```json
{
  "scripts": {
    "bundle": "wireit",
    "build": "wireit"
  },
  "wireit": {
    "tasks": {
      "bundle": {
        "command": "rollup -c",
        "dependencies": [
          "tsc",
        ],
        "files": [
          "rollup.config.js"
        ]
      },
      "build": {
        "command": "tsc",
        "fail": "eventually",
        "files": [
          "src/**/*.ts",
          "tsconfig.json"
        ]
      },
    }
  }
}
```
<!-- prettier-ignore-end -->

## Run status

By default, the fact that a task ran at all is sufficient to cause all
downstream tasks to also run, because it is assumed that the first task may have
produced new output which is an input to the second task.

In some cases, it may be useful to distinguish between a task that ran but
didn't actually make any changes that would affect downstream tasks. For
example, imagine a program that conditionally writes to an external database,
which is then read by downstream processes. If the database did not need to be
updated, then the tasks that read from that database don't need to run just
because the updating program ran.

Writing `::wireit-status=noop` to the `stdout` of a task will cause the task to
act as though it didn't run.

You can write this string directly from your program, for example:

```js
const databaseChanged = updateDatabase();
if (!databaseChanged) {
  console.log('::wireit-status=noop');
}
```

You could also use `grep` or any similar command to check for a different
string, and write `::wireit-status=noop` when it is present:

```json
{
  "command": "write-database | grep updated && echo ::wireit-status=noop || true"
}
```

## Caching

By default, only 1 previous state can be cached for each task.

Adding an `output` property to a task allows wireit to track the specific
outputs of each task, allowing for an arbitrary number of historical outputs to
be tracked.

An example of how this can be useful is if you save, make a change, save, undo
change, save. By default, this would require 3 builds, but if the outputs are
tracked, it only requires 2. That's because wireit notices that the inputs to
the 3rd save were the same as the 1st, so it can restore the cached output of
the 1st build.

```json
{
  "scripts": {
    "build": "wireit",
    "build:watch": "wireit watch build",
  },
  "wireit": {
    "tasks": {
      "ts": {
        "command": "tsc",
        "dependencies": {
          "../another-package:build"
        },
        "files": [
          "src/**/*.ts",
          "tsconfig.json"
        ],
        "output": [
          "lib/**/*",
        ]
      }
    }
  }
}
```

## Comparisons

### Comparison to Bazel

- An NPM package is similar to a Bazel package. An NPM package is defined as a
  directory containing a `package.json` file, while a Bazel package is defined
  as a directory containing a `BUILD` file.

- A wireit task is similar to a Bazel target.

- The `wireit watch <task>` command is similar to `ibazel <target>`.

- Bazel is implemented in Java. wireit is implemented in JavaScript.

- wireit is simpler to configure than Bazel. wireit uses a compact JSON
  configuration inside `package.json` files, while Bazel requires separate
  `BUILD` files with its own syntax.

### Comparison to Turborepo

- wireit and Turborepo both use `package.json` files to define the build
  graph.

- When used across multiple packages (e.g. in a monorepo), wireit allows
  declaring tasks within each sub-package's `package.json`. Turborepo requires
  defining the build graph for all packages in the top-level `package.json`.

- Turborepo treats all files within a package as dependencies of the tasks in
  that package. This means that optimal builds typically require splitting every
  package's build step into its own sub-package. wireit is more granular,
  allowing specific tasks to depend on specific files.

- Turborepo supports remote caching. wireit does not.

- Bazel is implemented in Go. wireit is implemented in JavaScript.

- wireit can be easily integrated into standard `npm run <script>` commands,
  so you don't need to change the way you run your scripts. Turborepo requires
  invoking all commands through the `turbo` command.

### Comparison to Nx

- Both Nx and wireit are implemented in JavaScript.
