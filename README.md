<img src="wireit.svg" height="80" alt="wireit"/>

> A lightweight NPM script runner for incremental builds

Wireit upgrades your npm scripts to make them smarter and more efficient.

## Features

- 🙂 Use the `npm run` commands you already know
- 🛠️ Works with single packages, npm workspaces, and Lerna
- ⛓️ Automatically run dependencies between npm scripts in parallel
- 👀 Watch any script and continuously re-run on changes
- 🥬 Skip scripts that are already fresh
- ♻️ Cache output locally and on GitHub Actions

## Contents

- [Features](#features)
- [Install](#install)
- [Setup](#setup)
- [Dependencies](#dependencies)
  - [Vanilla scripts](#vanilla-scripts)
  - [Cross package dependencies](#cross-package-dependencies)
- [Freshness tracking](#freshness-tracking)
- [Watch mode](#watch-mode)
- [Caching](#caching)
  - [GitHub Actions caching](#github-actions-caching)
  - [Only status required](#only-status-required)
- [Monorepos](#monorepos)
  - [npm workspaces](#npm-workspaces)
- [NPM package locks](#npm-package-locks)
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
`wireit.<script>.files` list:

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
[Lerna](https://lerna.js.org/) monorepos, without any additional configuration.

Wireit is agnostic to whether you are using these tools, because you can
configure cross-package script dependencies by using a relative path to the
other package's directory, followed by a `:` character, followed by the script
name. For example:

```json
{
  "scripts": {
    "build": "wireit"
  },
  "wireit": {
    "build": {
      "command": "tsc",
      "dependencies": ["../other-pkg:build"]
    }
  }
}
```

> When moving from one package to another, `wireit` always runs scripts using
> `npx` with the `cwd` set to the script's package directory, so the `$PATH` is
> always set correctly.

### npm workspaces

Wireit works great with [npm
workspaces](https://docs.npmjs.com/cli/v7/using-npm/workspaces). All of the
built-in `npm` workspaces commands will work with no extra configuration.

For example, to run the `build` script in all of your packages:

```sh
cd <workspaces-root>
npm run build --workspaces --if-present
```

This `npm` runs the `build` script in all of your packages (if they have one).
Since `wireit` scripts are regular `npm` scripts, any script which you've
configured for `wireit` will automatically take advantage of wireit's extra
features.

#### Optimizing npm workspaces

Because `npm run --workspaces` always runs your scripts sequentially in the
order they were defined in your `package.json`, those scripts won't be able to
run in parallel.

To create a more optimal cross-workspace script, you can define a script in your
workspaces root `package.json` using the special `$WORKSPACES:<script>`
dependency.

```json
{
  "scripts": {
    "build": "wireit"
  },
  "wireit": {
    "build": {
      "dependencies": ["$WORKSPACES:build"]
    }
  }
}
```

Now when you run `npm run build` from your workspaces root, your `build` scripts
will run in parallel whenever possible.

You can also just write `$WORKSPACES` if the scripts have the same name as the
current one.

> When using `$WORKSPACES`, wireit is careful to only parallelize when it's
> sure that it's safe. A script that is not configured for wireit will not run
> concurrently with a script that is. Wireit will respect the order of your
> workspace packages by only parallelizing contiguous blocks of wireit scripts.

### Lerna monorepos

Wireit works great with [Lerna](https://lerna.js.org/) monorepos too. All of the
`lerna` commands will work with no extra configuration.

For example, to run the `build` script in all of your packages:

```sh
cd <lerna-root>
npx lerna run build --stream
```

This Lerna command runs the `build` script in all of your packages (if they have
one), in the topological order determined by the `dependencies` and
`devDependencies` section of your `package.json` files, parallelizing where
possible. Since `wireit` scripts are regular `npm` scripts, any script which
you've configured for `wireit` will automatically take advantage of wireit's
extra features.

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

## NPM package locks

Wireit automatically treats any `package-lock.json` file in the package
directory, or any of its parent directories, like an input file. This means when
you `npm install` or `npm upgrade` a package dependency, all scripts will be
considered stale, in case their behavior might have changed.

If you're sure a script doesn't make use of any npm package dependencies, you
can turn off this behavior by setting `wireit.<script>.checkNpmPackageLocks` to
`false`.

## Configuration reference

### Dependencies

| _Example_                    | _Description_                                                                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Same package**             |                                                                                                                                                             |
| `build`                      | A script named "build" in the current package.                                                                                                              |
| **Other packages**           |                                                                                                                                                             |
| `../other-pkg:build`         | A script named "build" in the `../other-pkg/` directory (note this is a _filesystem path_, not an npm package name).                                        |
| `$other-pkg:build`           | A script named "build" in the `other-pkg` npm package, where `other-pkg` is found using Node `require()`-style package resolution                           |
| **npm workspaces**           |                                                                                                                                                             |
| `$WORKSPACES`                | All scripts with the same name as the current one which are in each of this package's [npm workspaces](https://docs.npmjs.com/cli/v7/using-npm/workspaces). |
| `$WORKSPACES:build`          | All scripts named "build" in each of this package's npm workspaces.                                                                                         |
| `$WORKSPACE_DEPS`            | All scripts with the same name as the current one which are in this package's npm workspace dependencies.                                                   |
| `$WORKSPACE_DEPS:build`      | All scripts named "build" which are in this package's npm workspace dependencies.                                                                           |
| **Lerna**                    |                                                                                                                                                             |
| `$LERNA_DEPS`                | All scripts with the same name as the current one which are in this package's Lerna dependencies.                                                           |
| `$LERNA_DEPS:build`          | All scripts named "build" which are in this package's Lerna dependencies.                                                                                   |
| **Escaping**                 |                                                                                                                                                             |
| `\\../other-pkg:build`       | A script in the current package literally named `"./other-package:build"`.                                                                                  |
| `../other-pkg\\:build:build` | A script named `build` in the directory literally named `"../other-package:build"`.                                                                         |
| `\\$WORKSPACE_DEPS`          | A script in the current package literally named `"$WORKSPACE_DEPS"`.                                                                                        |
