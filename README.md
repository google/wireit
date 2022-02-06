
<img src="wireit.svg" height="80" alt="wireit"/>

> A lightweight NPM script runner for incremental builds

Wireit upgrades your NPM scripts to make them smarter and more efficient.

## Features

- 🔗 Automatically run dependencies between your NPM scripts
- 👀 Watch any script to continuously re-run when files change
- ♻️ Cache script output locally or in the GitHub Actions cache
- 🙂 Use the `npm run` syntax you already know

## Example

> package.json

```json
{
  "name": "my-project",
  "scripts": {
    "build": "wireit",
    "test": "wireit",
    "ts": "wireit",
    "rollup": "wireit"
  },
  "wireit": {
    "tasks": {
      "build": {
        "dependencies": ["rollup"]
      },
      "test": {
        "command": "uvu lib/test",
        "dependencies": ["ts"]
      },
      "ts": {
        "command": "tsc",
        "files": ["src/**/*.ts", "tsconfig.json"]
      },
      "rollup": {
        "command": "rollup -c",
        "dependencies": ["ts"],
        "files": ["rollup.config.js"]
      }
    }
  }
}
```

1. When you first run `npm run build`, `tsc` and `rollup` run.
2. When you modify `rollup.config.js` and run `npm run build` again, only `rollup` runs. Wireit knows that `tsc` doesn't need to run because its input files didn't change.
3. When you run `npm test -- watch`, every time you modify a `.ts` file, `tsc` and `uvu` will run.

## Recipes

### How do I configure a script with wireit?

1. Create a `wireit` object in your `package.json`, and a `tasks` object within that.
2. Add an entry to `wireit.tasks` with the same script name, and set `command` to the same script value.
3. Replace the `script` entry with `wireit`. Wireit doesn't need any arguments because it uses the [`npm_lifecycle_event`](https://docs.npmjs.com/cli/v8/using-npm/scripts#current-lifecycle-event) environment variable to determine which NPM script is running.
4. Use `dependencies` to declare which other scripts must run before this one.
5. Use `files` to declare which files must change to require the script to run again.

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
    "build": "npm run ts && npm run bundle",
    "bundle": "rollup -c",
    "ts": "tsc"
  }
}
</pre>
</td>
<td>
<pre lang="json">
{
  "scripts": {
    "build": "wireit",
    "ts": "wireit",
    "rollup": "wireit"
  },
  "wireit": {
    "tasks": {
      "build": {
        "dependencies": ["bundle"]
      },
      "bundle": {
        "command": "rollup -c",
        "dependencies": ["ts"],
        "files": ["rollup.config.js"]
      },
      "ts": {
        "command": "tsc",
        "files": ["src/**/*.ts", "tsconfig.json"]
      }
    }
  }
}
</pre>
</td>
</tr>
</table>

### How do I run a wireit script?

Run `npm run <task>`. Wireit scripts are regular NPM scripts, so you use the NPM commands you already know.

### How do I watch a wireit script?

Run `npm run <task> -- watch`. Wireit can watch any script, and re-runs it any time an input file to it or any of its dependencies changes. Note the `--` is needed so that the `watch` argument is passed to `wireit`, instead of `npm`.

### How do I use wireit with a monorepo?

Wireit can reference dependencies in other packages using `<path-to-package>:<script>` syntax. For example:

```json
{
  "scripts": {
    "ts": "wireit"
  },
  "wireit": {
    "tasks": {
      "ts": {
        "command": "tsc",
        "dependencies": ["../my-other-package:ts"],
        "files": ["src/**/*.ts", "tsconfig.json"]
      }
    }
  }
}
```

### How does wireit handle failures?

By default, when a script fails, then none of the scripts that depend on it will run.

> ⚠️ NOT YET IMPLEMENTED

In some cases, it is useful to allow a script to continue in spite of a failure in one of its dependencies. To change this behavior, set `fail` to `eventually` in the script that is allowed to fail. Note that in `eventually` mode, the _overall_ `npm run` command will always fail if any dependency failed.

For example, TypeScript will emit JavaScript even when there is a typing error, and we may want to let subsequent tasks consume that JavaScript in spite of the error:

```json
{
  "scripts": {
    "ts": "wireit",
    "bundle": "wireit"
  },
  "wireit": {
    "tasks": {
      "ts": {
        "command": "tsc",
        "dependencies": ["../my-other-package:ts"],
        "files": ["src/**/*.ts", "tsconfig.json"],
        "fail": "eventually"
      },
      "bundle": {
        "command": "rollup -c",
        "dependencies": ["ts"],
        "files": ["rollup.config.js"]
      }
    }
  }
}
```

### How do I cache output in GitHub Actions CI?

> ⚠️ NOT YET IMPLEMENTED

1. Ensure every script whose output you want to be cached has an `output` section.
2. Use `aomarks/wireit-github-workflow` to automatically use [GitHub Caching](https://docs.github.com/en/actions/advanced-guides/caching-dependencies-to-speed-up-workflows) to restore the output of any script whose input files have not changed in the current PR.

```yaml
steps:
  - name: Enable caching of wireit script output
    uses: aomarks/wireit-github-workflow@v1

  - name: Test
    run: npm test
```

Now when wireit runs a script, it uses the hashes of all transitive input files as a key to check the GitHub cache for an existing output tarball. Whenever possible, wireit will use a cached tarball instead of running the script. Furthermore, when a script and all of its dependencies have a cache hit, wireit doesn't even need to download any tarballs, because it knows that no output could have changed.

To disable caching for a particular script, use `with.no-cache`:

```yaml
steps:
  - name: Enable caching of wireit script output
    uses: aomarks/wireit-github-workflow@v1
    with:
      no-cache: |
        foo
        packages/foo:bar
```
