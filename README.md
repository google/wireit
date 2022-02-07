<img src="wireit.svg" height="80" alt="wireit"/>

> A lightweight NPM script runner for incremental builds

Wireit upgrades your npm scripts to make them smarter and more efficient.

## Features

- ⛓️ Automatically run dependencies between your NPM scripts in parallel
- 🥬 Check scripts for freshness, and skip them if they don't need to run
- 👀 Watch any script to continuously re-run when files change
- ♻️ Cache prior output locally, or remotely in your GitHub Actions
- 🛠️ Works with single packages, npm workspaces, and Lerna monorepos
- 🙂 Use the `npm run` commands you already know

## Contents

- [Features](#features)
- [Install](#install)
- [Setup](#setup)
- [Dependencies](#dependencies)
- [Freshness tracking](#freshness-tracking)
- [Watch mode](#watch-mode)
- [Caching](#caching)
  - [GitHub Actions caching](#github-actions-caching)
  - [Only status required](#only-status-required)
- [Monorepos](#monorepos)
- [Comparison](#comparison)

## Install

```sh
npm i -D wireit
```

## Setup

Wireit works _with_ `npm run` instead of replacing it. To configure an NPM
script for `wireit`, move the command into a new `wireit` section of your
`package.json`, and replace the original script with the `wireit` command.

<table>
<tr>
<th>Before</th>
<th>After</th>
</tr>
<tr>
<td>
<pre lang="json">
{
  "scripts": {
    "build": "tsc"
  }
}
</pre>
</td>
<td>
<pre lang="json">
{
  "scripts": {
    "build": "wireit"
  },
  "wireit": {
    "build": {
      "command": "tsc"
    }
  }
}
</pre>
</td>
</tr>
</table>

Now when you run `npm run build`, `wireit` will manage the execution of your
script behind-the-scenes, upgrading it with power of a dependency graph,
caching, watch mode, and more.

> The `wireit` command doesn't need any arguments, because it uses the
> [`npm_lifecycle_event`](https://docs.npmjs.com/cli/v8/using-npm/scripts#current-lifecycle-event)
> environment variable to determine which NPM script is running.

You should also add `.wireit` to your `.gitignore` file. Wireit uses the
`.wireit` directory to store caches and other data for your scripts.

```sh
echo .wireit >> .gitignore
```

## Dependencies

When you `npm run` a script that has been configured for `wireit`, the script's
command doesn't always run right away. Instead, the _dependencies_ of each
script are run first, if needed. To declare a dependecy between two scripts,
edit the `wireit.<script>.dependencies` list:

```json
{
  "scripts": {
    "build": "wireit",
    "bundle": "wireit"
  },
  "wireit": {
    "build": {
      "command": "tsc"
    },
    "bundle": {
      "command": "rollup -c",
      "dependencies": ["build"]
    }
  }
}
```

Now when you run `npm run bundle`, the `build` script will automatically run
first. This way, you don't have to remember the order that your scripts need to
run in. This is also better than a chained shell command like `tsc && rollup -c`, because of _freshness tracking_ and _caching_.

### Vanilla scripts

The scripts you depend on don't themselves have to be configured for `wireit`,
they can just be vanilla `npm` scripts. This makes it easy to incrementally
configure `wireit`, or only use it for some of your scripts. Scripts that
haven't been configured for `wireit` yet are always safe to use as dependencies;
they just won't yet be optimized with freshness checking and caching.

### Cross package dependencies

Dependencies can also refer to scripts in _other_ npm packages, by using a
relative path (e.g. `../my-other-package:build`). See [monorepos](#monorepos)
for more on cross-package dependencies.

## Freshness tracking

After you `npm run` a `wireit` script, `wireit` stores a record of the exact
inputs to the script inside the `.wireit/state` directory. The next time you run
the script, `wireit` checks the inputs again, and if nothing changed, the script
is considered _fresh_ and skips execution.

To enable freshness tracking, tell `wireit` what your input files are using the
`wireit.<command>.files` list:

```json
{
  "scripts": {
    "build": "wireit",
    "bundle": "wireit"
  },
  "wireit": {
    "build": {
      "command": "tsc",
      "files": ["src/**/*.ts", "tsconfig.json"]
    },
    "bundle": {
      "command": "rollup -c",
      "dependencies": ["build"],
      "files": ["rollup.config.json"]
    }
  }
}
```

> Note we didn't need to include `lib/**/*.js` in the `wireit.bundle.files`
> list, because those files are implicitly tied to the output status of `build`.
> If a dependency of a script runs, then wireit always assumes that it could
> have produced new input for every script that depends on it.

Now when you run `npm run bundle`, `wireit` first checks if `build` is already
fresh by comparing the contents of `src/**/*.ts` and `tsconfig.json` to last
time. Then it checks if `bundle` is fresh by checking `rollup.config.json`. This
way, if you only change your `rollup.config.json` file, then the `build` command
won't run again. And if you've only changed your `README.md` file, then neither
script runs again, because `wireit` knows that `README.md` isn't an input to
either script.

> If a script doesn't have a `files` list defined at all, then it will _always_
> run, because `wireit` doesn't want to accidentally skip execution of scripts
> that haven't been fully configured yet. To allow a script to be freshness
> checked that really has no input files, set `files` to an empty array (`files: []`).

## Watch mode

You can watch and automatically re-run any script that is configured for
`wireit` with `npm run <script> -- watch`.

> Note the `--` is needed so that the `watch` argument is passed to `wireit`,
> instead of `npm`.

In watch mode, whenever an input file to a script changes, then the script
automatically re-runs. And if an input file of a dependency changes, then the
dependency automatically runs too. This way, no matter how complex your build
graph, you can freely jump around in your project, edit any file, and
automatically start computing the result instantly.

Wireit's watch mode is also better than running the built-in watch modes that
many tools come with, because it prevents race conditions and redundant builds.
For example, if you run `tsc --watch & rollup -c --watch`, then it's possible
for `rollup` to be triggered _while `tsc` is only part-way done emitting its
output_, requiring another build afterwards, or even causing an error due to
consuming an incomplete build.

## Caching

If a script isn't currently fresh, but has _previously_ successfully run with
the exact input state, then `wireit` can _copy_ the output from the cache,
instead of running the command. To enable caching, tell `wireit` what the output
files of your scripts are:

```json
{
  "scripts": {
    "build": "wireit",
    "bundle": "wireit"
  },
  "wireit": {
    "build": {
      "command": "tsc",
      "files": ["src/**/*.ts", "tsconfig.json"],
      "output": ["lib/**/*"]
    },
    "bundle": {
      "command": "rollup -c",
      "dependencies": ["build"],
      "files": ["rollup.config.json"],
      "output": ["dist/bundle.js"]
    }
  }
}
```

Now when you run `npm run bundle`, if the script is not fresh, then `wireit`
will first check the `.wireit/cache` directory to see it already has cached
output, before it runs the command.

> If a script doesn't have an `output` list defined at all, then it will _never_
> be cached, because `wireit` doesn't want to accidentally cache empty output
> for a script that hasn't been fully configured yet. To allow a script to be
> cached that really produces no output (such as a test), set `output` to an
> empty array (`output: []`). Obviously no output will be copied from the cache
> in this case, but it will still allow the script to be skipped when a cache
> hit is detected.

## Monorepos

Wireit works great with either [npm
workspaces](https://docs.npmjs.com/cli/v7/using-npm/workspaces) or
[Lerna](https://lerna.js.org/) monorepos. In fact, wireit is unopinionated about
how your packages are laid out, and doesn't need to know whether you have a
monorepo, or what kind it is.

To configure a cross-package script dependency, use a relative path to the other
package, followed by a `:` character, followed by the script name. For example:

```json
{
  "scripts": {
    "build": "wireit"
  },
  "wireit": {
    "build": {
      "command": "tsc",
      "dependencies": ["../my-other-package:build"]
    }
  }
}
```

> When moving from one package to another, `wireit` always runs scripts with the
> `cwd` set to the script's package directory with `npx`, so the `$PATH` is
> always set correctly.

### GitHub Actions caching

Wireit caching also works _across different builds_ when you use GitHub Actions.
This works the same way as local caching, except wireit checks the remote GitHub
Actions Cache, instead of the local filesystem. To enable remote caching with
GitHub Actions, use the `aomarks/wireit-github-actions` workflow before you run
your scripts:

```yaml
steps:
  - name: Enable wireit caching
    uses: aomarks/wireit-github-actions@v1

  - name: Test
    run: npm test
```

> All GitHub users get 500MB of free storage with GitHub Actions which can be
> used for caching, and paid users can get more. The most recently accessed
> cache entries will be preferred if you hit your quota. See [About billing for
> GitHub
> Actions](https://docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions)
> for more information about quota.

### Only status required

It's often the case, particularly when running tests in CI, that we would prefer
to entirely skip tests for which there is no possible way for its result to have
changed since the last time it successfully ran. Wireit's caching feature
already gets you most of this benefit, because it prefer to download output
files from the cache rather than recompute it, but we can do even better by
using the `--only-status-required` flag.

When you run `npm run <script> -- --only-status-required`, then the output files
for the script, and all of its transitive dependencies, _won't even be
downloaded from the cache_, unless they are needed by a script that isn't
cached.

Using this flag is recommended for use-cases like running tests in CI:

```yaml
steps:
  - name: Enable wireit caching
    uses: aomarks/wireit-github-actions@v1

  - name: Test
    run: npm test -- --only-status-required
```

Now when tests run in CI, if none of the transitive input files to `test` have
changed since the last successful run, then no files will need to be downloaded
from the cache at all. Instead, only much smaller _manifest_ files are
downloaded from the cache, describing the files that _would_ be outputted.

## Comparisons

Wireit shares many similarities with number of other great tools, and we
encourage you to check them too before you start using wireit.

### Basics

|                                                   | Base <br> install size | Transitive <br> deps | Implementation <br> language |
| ------------------------------------------------- | ---------------------- | -------------------- | ---------------------------- |
| [Wireit](#readme)                                 | `1.6MB`                | 24                   | JavaScript                   |
| [Nx](https://nx.dev/)                             | `22MB`                 | 58                   | JavaScript                   |
| [Turborepo](https://turborepo.org/)               | `8.6MB`                | ??                   | Go                           |
| [Lerna](https://lerna.js.org/)                    | `85MB`                 | 613                  | JavaScript                   |
| [Bazel](https://bazel.build/)                     | `191MB`                | ??                   | Java                         |
| [npm](https://docs.npmjs.com/cli/v6/commands/npm) | `17MB`                 | 1                    | JavaScript                   |

### Usage

|                                                   | Run command   | Watch command                                                          | Configuration                 |
| ------------------------------------------------- | ------------- | ---------------------------------------------------------------------- | ----------------------------- |
| [Wireit](#readme)                                 | `npm run`     | ✅ ([`npm run -- watch`](#watch-mode))                                 | `package.json`                |
| [Nx](https://nx.dev/)                             | `nx run`      | ✅ ([`nx build --watch`](https://nx.dev/cli/build#watch))              | `nx.json` + `package.json`    |
| [Turborepo](https://turborepo.org/)               | `turbo run`   | ❌ ([discussion](https://github.com/vercel/turborepo/discussions/206)) | `package.json` (root only)    |
| [Lerna](https://lerna.js.org/)                    | `lerna run`   | ❌                                                                     | `lerna.json` + `package.json` |
| [Bazel](https://bazel.build/)                     | `bazel build` | ✅ ([`ibazel`](https://github.com/bazelbuild/bazel-watcher))           | `BUILD` files                 |
| [npm](https://docs.npmjs.com/cli/v6/commands/npm) | `npm run`     | ❌                                                                     | `package.json`                |

### Features

|                                                   | Parallel<br>Execution | Distributed<br>Execution | Local<br>Caching | Remote<br>Caching                                                                |
| ------------------------------------------------- | --------------------- | ------------------------ | ---------------- | -------------------------------------------------------------------------------- |
| [Wireit](#readme)                                 | ✅                    | ❌                       | ✅               | ✅ ([GitHub Actions](#github-actions-caching))                                   |
| [Nx](https://nx.dev/)                             | ✅                    | ✅                       | ✅               | ✅ ([Nx Cloud](https://nx.app/))                                                 |
| [Turborepo](https://turborepo.org/)               | ✅                    | ❌                       | ✅               | ✅ ([Vercel](https://turborepo.org/docs/features/remote-caching))                |
| [Lerna](https://lerna.js.org/)                    | ✅                    | ❌                       | ❌               | ❌                                                                               |
| [Bazel](https://bazel.build/)                     | ✅                    | ✅                       | ✅               | ✅ ([Self-host / 3rd party](https://bazel.build/remote-execution-services.html)) |
| [npm](https://docs.npmjs.com/cli/v6/commands/npm) | ❌                    | ❌                       | ❌               | ❌                                                                               |

### Layout compatibility

|                                                   | Single<br>package | npm<br>workspaces | Lerna<br>monorepo |
| ------------------------------------------------- | ----------------- | ----------------- | ----------------- |
| [Wireit](#readme)                                 | ✅                | ✅                | ✅                |
| [Nx](https://nx.dev/)                             | ??                | ❌                | ❌                |
| [Turborepo](https://turborepo.org/)               | ❌                | ✅                | ✅                |
| [Lerna](https://lerna.js.org/)                    | ❌                | ❌                | ✅                |
| [Bazel](https://bazel.build/)                     | ❌                | ❌                | ❌                |
| [npm](https://docs.npmjs.com/cli/v6/commands/npm) | ✅                | ❌                | ❌                |
