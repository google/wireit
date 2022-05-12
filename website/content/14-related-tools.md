---
layout: layout.njk
title: Related tools
permalink: related-tools/index.html
eleventyNavigation:
  key: Related tools
  order: 14
---

## Related tools

Wireit shares a number of features with these other great tools, and we highly
recommend you check them out too:

- [Nx](https://nx.dev/)
- [Turborepo](https://turborepo.org/)
- [Chomp](https://chompbuild.com/)
- [Bazel](https://bazel.build/)

Here are some things you might especially like about Wireit:

- **Feels like npm**. When you use Wireit, you'll continue typing the same npm
  commands you already use, like `npm run build` and `npm test`. There are no
  new command-line tools to learn, and there's only one way to run each script.
  Your script config stays in your `package.json`, too. Wireit is designed to be
  the minimal addition to npm needed to get script dependencies and incremental
  build.

- **Caching with GitHub Actions**. Wireit supports caching build artifacts and
  test results directly through GitHub Actions, without any extra third-party
  services. Just add a single `uses:` line to your workflows.

- **Watch any script**. Want to automatically re-run your build and tests
  whenever you make a change? Type `npm test watch`. Any script you've
  configured using Wireit can be watched by typing `watch` after it.

- **Great for single packages and monorepos**. Wireit has no opinion about how
  your packages are arranged. It works great with single packages, because you
  can link together scripts within the same package. It also works great with
  any kind of monorepo, because you can link together scripts across different
  packages using relative paths.

- **Complements npm workspaces**. We think Wireit could be the missing tool that
  unlocks the potential for [npm
  workspaces](https://docs.npmjs.com/cli/v8/using-npm/workspaces) to become the
  best way to set up monorepos. To use Wireit with npm workspaces, you'll just
  use standard npm workspace commands like `npm run build -ws`.

- **Adopt incrementally**. Wireit scripts can depend on plain npm scripts, so
  they can be freely mixed. This means you can use Wireit only for the parts of
  your build that need it most, or you can try it out on a script-by-script
  basis without changing too much at the same time.
