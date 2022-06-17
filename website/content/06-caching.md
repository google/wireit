---
layout: layout.njk
title: Caching
permalink: caching/index.html
eleventyNavigation:
  key: Caching
  order: 6
---

## Caching

If a script has previously succeeded with the same configuration and input
files, then Wireit can copy the output from a cache, instead of running the
command. This can significantly improve build and test time.

To enable caching for a script, ensure you have defined both the [`files` and
`output`](../files/) arrays.

> ℹ️ If a script doesn't produce any output files, it can still be cached by
> setting `output` to an empty array (`"output": []`). Empty output is common for
> tests, and is useful because it allows you to skip running tests if they
> previously passed with the exact same inputs.

### Local caching

In _local_ mode, Wireit caches `output` files to the `.wireit` folder inside
each of your packages.

Local caching is enabled by default, unless the
[`CI=true`](https://docs.github.com/en/enterprise-cloud@latest/actions/learn-github-actions/environment-variables#default-environment-variables)
environment variable is detected. To force local caching, set
`WIREIT_CACHE=local`. To disable local caching, set `WIREIT_CACHE=none`.

> ⚠️ Wireit does not currently limit the size of local caches. To free up this
> space, use `rm -rf .wireit/*/cache`. Automatic cache size limits will be added
> in an upcoming release, tracked at
> [wireit#71](https://github.com/google/wireit/issues/71).

### GitHub Actions caching

In _[GitHub Actions](https://github.com/features/actions)_ mode, Wireit caches
`output` files to the [GitHub Actions
cache](https://docs.github.com/en/actions/using-workflows/caching-dependencies-to-speed-up-workflows)
service. This service is available whenever running in GitHub Actions, and is
free for all GitHub users.

> ℹ️ GitHub Actions cache entries are automatically deleted after 7 days, or if
> total usage exceeds 10 GB (the least recently used cache entry is deleted
> first). See the [GitHub Actions
> documentation](https://docs.github.com/en/actions/using-workflows/caching-dependencies-to-speed-up-workflows#usage-limits-and-eviction-policy)
> for more details.

To enable caching on GitHub Actions, add the following
[`uses`](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idstepsuses)
clause to your workflow. It can appear anywhere before the first `npm run` or
`npm test` command:

```yaml
- uses: google/wireit@setup-github-actions-caching/v1
```

#### Example workflow

```yaml
# File: .github/workflows/tests.yml

name: Tests
on: [push, pull_request]
jobs:
  tests:
    os: ubuntu-20.04
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 16
          cache: true

      # Set up GitHub Actions caching for Wireit.
      - uses: google/wireit@setup-github-actions-caching/v1

      # Install npm dependencies.
      - run: npm ci

      # Run tests. Wireit will automatically use
      # the GitHub Actions cache whenever possible.
      - run: npm test
```
