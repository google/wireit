---
layout: docs.njk
title: Introduction
permalink: docs/index.html
eleventyNavigation:
  key: Introduction
  order: 0
---

## Introduction

Wireit is a tool that allows you to incrementally convert your project's
existing [npm scripts](https://docs.npmjs.com/misc/scripts) into an intelligent
and efficient build and service orchestration system.

### Easy onramp and offramp

Wireit is only concerned with scripts. Wireit is not a workspace manager or a
package manager. Wireit works with npm; it does not replace it.

Adopting Wireit doesn't mean changing the layout of your project or adopting a
particular style of monorepo. Npm scripts can be converted to Wireit scripts on
an individual basis, and are invoked in exactly the same way you invoke them
now.

### Install

Install Wireit to your project's dev dependencies. This is recommended over a
global dependency, since it will be easier to keep your team on the same
version.

```sh
npm i -D wireit
```

### Update ignore files

Add the `.wireit` folder to your [Git ignore
file](https://git-scm.com/docs/gitignore), as well as to the exclude paths of
any linters you might be using.

```sh
echo ".wireit" >> .gitignore
```

### Convert a script to Wireit

Converting an npm script to wireit consists of two steps:

1. Change the `script` to delegate to the `wireit` binary.
2. Add a `wireit` section to your `package.json`, with an entry for the script,
   and set the original `script` as the `command`.
3. Add addition hints as needed to tell Wireit about dependencies, input files,
   and output files.

#### Original

```json
{
  "scripts": {
    "build": "npm run build:js && npm run build:site",
    "build:site": "eleventy",
    "build:js": "esbuild"
  }
}
```

#### Converted to Wireit

```json
{
  "scripts": {
    "build": "wireit",
    "build:site": "wireit",
    "build:js": "wireit"
  },
  "wireit": {
    "build": {
      "command": "npm run build:js && npm run build:site"
    },
    "build:site": {
      "command": "eleventy"
    },
    "build:js": {
      "command": "esbuild"
    }
  }
}
```

#### Configured

The `wireit` section is now expanded, telling Wireit which scripts must run
first, and declaring input and output files. The main `build` script has been
converted from a chain of shell commands to simply delegate to `build:site`,
which in turn depends on `build:js`.

```json
{
  "scripts": {
    "build": "wireit",
    "build:site": "wireit",
    "build:js": "wireit"
  },
  "wireit": {
    "build": {
      "dependencies": ["build:site"]
    },
    "build:site": {
      "command": "eleventy",
      "dependencies": ["build:js"],
      "input": ["content/"],
      "output": ["_site/"]
    },
    "build:js": {
      "command": "esbuild",
      "input": ["src/**/*.ts"],
      "output": ["dist/**/*.js"]
    }
  }
}
```

### Run a Wireit script

Wireit scripts are run in exactly the same way standard npm script are run:

```sh
npm run build
```

1. Wireit will check if any `src/**/*.ts` files have changed since the last
   time, and if they have it will re-build `build:js`.

2. Wireit will check if any `content/` files have changed since the last time,
   and if they have it will re-build `build:site`.

You also now have access to universal watch mode, which will monitor the input
files of both, and re-build all of the steps that depend on them.

```sh
npm run build --watch
```

### Next steps

This page covers the basics of setting up and installing Wireit. There are a lot
of other details and features to cover.
