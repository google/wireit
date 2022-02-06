
<img src="wireit.svg" height="80" alt="wireit"/>

> A lightweight NPM script runner for incremental builds

Wireit upgrades your NPM scripts to make them smarter and more efficient.

## Features

- ⛓️ Automatically run dependencies between your NPM scripts in parallel
- 🥬 Check scripts for freshness, and skip them if they don't need to run
- 👀 Watch any script to continuously re-run when files change
- ♻️ Cache prior output locally, or remotely in your GitHub Actions
- 🙂 Use the `npm run` commands you already know

## Contents

- [Features](#features)
- [Install](#install)
- [Setup](#setup)
- [Dependencies](#dependencies)
- [Freshness tracking](#freshness-tracking)
- [Caching](#caching)
  - [GitHub Actions caching](#github-actions-caching)
  - [Only status required](#only-status-required)
- [Watch mode](#watch-mode)


## Install

```sh
npm i -D wireit
```

## Setup

Wireit works *with* `npm run` instead of replacing it. To configure an NPM script for `wireit`, move the command into a new `wireit` section of your `package.json`, and replace the original script with the `wireit` command.

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

Now when you run `npm run build`, `wireit` will manage the execution of your script behind-the-scenes, upgrading it with power of a dependency graph, caching, watch mode, and more.

> The `wireit` command doesn't need any arguments, because it uses the [`npm_lifecycle_event`](https://docs.npmjs.com/cli/v8/using-npm/scripts#current-lifecycle-event) environment variable to determine which NPM script is running.

## Dependencies

When you `npm run` a script that has been configured for `wireit`, then the script's command doesn't always run right away. Instead, the *dependencies* of each script are run first, if needed. To declare a dependecy between two tasks, edit the `wireit.<task>.dependencies` list:

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

Now when you run `npm run bundle`, the `build` script will automatically run first. This way, you don't have to remember the order that your scripts need to run in. This is also better than a chained shell command like `tsc && rollup -c`, because of *freshness tracking* and *caching*.

## Freshness tracking

After you `npm run` a `wireit` script, `wireit` stores a record of the exact inputs to the script inside the `.wireit/state` directory. The next time you run the script, `wireit` checks the inputs again, and if nothing changed, the script is considered *fresh* and skips execution.

To enable freshness tracking, tell `wireit` what your input files are using the `wireit.<command>.files` list:

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

Now when you run `npm run bundle`, `wireit` first checks if `build` is already fresh by comparing the contents of `src/**/*.ts` and `tsconfig.json` to last time. Then it checks if `bundle` is fresh by checking `rollup.config.json`. This way, if you only change your `rollup.config.json` file, then the `build` command won't run again. And if you've only changed your `README.md` file, then neither script runs again, because `wireit` knows that `README.md` isn't an input to either script.

> If a script doesn't have a `files` list defined at all, then it will *always* run, because `wireit` doesn't want to accidentally skip execution only because you haven't yet gotten around to declaring your input files. To allow a script to be freshness checked that really has no input files, set `files` to an empty array (`files: []`).

## Watch mode

You can watch and automatically re-run any script that is configured for `wireit` with `npm run <script> -- watch`.

> Note the `--` is needed so that the `watch` argument is passed to `wireit`, instead of `npm`.

In watch mode, whenever an input file to a script changes, then the script automatically re-runs. And if an input file of a dependency changes, then the dependency automatically runs too. This way, no matter how complex your build graph, you can freely jump around in your project, edit any file, and automatically start computing the result instantly.

Wireit's watch mode is also better than running the built-in watch modes that many tools come with, because it prevents race conditions and redundant builds. For example, if you run `tsc --watch & rollup -c --watch`, then it's possible for `rollup` to be triggered *while `tsc` is only part-way done emitting its output*, requiring another build afterwards, or even causing an error due to consuming an incomplete build.

## Caching

If a script isn't currently fresh, but has *previously* successfully run with the exact input state, then `wireit` can *copy* the output from the cache, instead of running the command. To enable caching, tell `wireit` what the output files of your scripts are:

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

Now when you run `npm run bundle`, if the script is not fresh, then `wireit` will first check the `.wireit/cache` directory to see it already has cached output, before it runs the command.

> Occasionally, a script may be able to run faster than the time it takes to check and restore from a cache. Set `wireit.<task>.caching` to `false` to disable caching.

### GitHub Actions caching

Wireit caching also works *across different builds* when you use GitHub Actions. This works the same way as local caching, except wireit checks the remote GitHub Actions Cache, instead of the local filesystem. To enable remote caching with GitHub Actions, use the `aomarks/wireit-github-actions` workflow before you run your scripts:

```yaml
steps:
  - name: Enable wireit caching
    uses: aomarks/wireit-github-actions@v1

  - name: Test
    run: npm test
```

> All GitHub users get 500MB of free storage with GitHub Actions which can be used for caching, and paid users can get more. The most recently accessed cache entries will be preferred if you hit your quota. See [About billing for GitHub Actions](https://docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions) for more information about quota.

### Only status required

It's often the case, particularly when running tests in CI, that we would prefer to entirely skip tests for which there is no possible way for its result to have changed since the last time it successfully ran. Wireit's caching feature already gets you most of this benefit, because it prefer to download output files from the cache rather than recompute it, but we can do even better by using the `--only-status-required` flag.

When you run `npm run <script> -- --only-status-required`, then the output files for the script, and all of its transitive dependencies, *won't even be downloaded from the cache*, unless they are needed by a script that isn't cached.

Using this flag is recommended for use-cases like running tests in CI:

```yaml
steps:
  - name: Enable wireit caching
    uses: aomarks/wireit-github-actions@v1

  - name: Test
    run: npm test -- --only-status-required
```

Now when tests run in CI, if none of the transitive input files to `test` have changed since the last successful run, then no files will need to be downloaded from the cache at all. Instead, only much smaller *manifest* files are downloaded from the cache, describing the files that *would* be outputted.
