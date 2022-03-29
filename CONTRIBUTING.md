# How to Contribute

We'd love to accept your patches and contributions to this project. There are
just a few small guidelines you need to follow.

## Contributor License Agreement

Contributions to this project must be accompanied by a Contributor License
Agreement (CLA). You (or your employer) retain the copyright to your
contribution; this simply gives us permission to use and redistribute your
contributions as part of the project. Head over to
<https://cla.developers.google.com/> to see your current agreements on file or
to sign a new one.

You generally only need to submit a CLA once, so if you've already submitted one
(even if it was for a different project), you probably don't need to do it
again.

## Code Reviews

All submissions, including submissions by project members, require review. We
use GitHub pull requests for this purpose. Consult
[GitHub Help](https://help.github.com/articles/about-pull-requests/) for more
information on using pull requests.

## Community Guidelines

This project follows
[Google's Open Source Community Guidelines](https://opensource.google/conduct/).

## Getting started

```sh
git clone https://github.com/google/wireit.git
cd wireit
npm ci
npm run build
```

## Running tests

```sh
npm test
npm test watch
```

### Testing environment variables:

- `TEST_TIMEOUT`: Default millisecond timeout for test cases.
- `SHOW_TEST_OUTPUT`: Set to show all `stdout` and `stderr` from spawned wireit
  invocations in test cases.

## Known good tarball

Wireit is self-hosting: it is built and tested with itself. However, we don't
want to build and test with the exact same code we are editing during
development, becuase if we break something, we might be unable to build or test
at all, or we might build or test incorrectly (e.g. we might think tests passed
when actually the tests didn't even run).

For this reason, we instead check a _known good_ build of Wireit into the
`known-good.tgz` tarball in this Git repo, and install it as a `devDependency`
for running the `wireit` package's own scripts. To update the known good
tarball, run:

```sh
npm run update-known-good
```
