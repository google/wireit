---
layout: layout.njk
title: Dependencies
permalink: dependencies/index.html
eleventyNavigation:
  key: Dependencies
  order: 2
---

## Dependencies

To declare a dependency between two scripts, edit the
`wireit.<script>.dependencies` list:

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
first.

### Vanilla scripts

The scripts you depend on don't need to be configured for Wireit, they can be
vanilla `npm` scripts. This lets you only use Wireit for some of your scripts,
or to upgrade incrementally. Scripts that haven't been configured for Wireit are
always safe to use as dependencies; they just won't be fully optimized.

### Cross-package dependencies

Dependencies can refer to scripts in other npm packages by using a relative path
with the syntax `<relative-path>:<script-name>`. All cross-package dependencies
should start with a `"."`. Cross-package dependencies work well for npm
workspaces, as well as in other kinds of monorepos.

```json
{
  "scripts": {
    "build": "wireit"
  },
  "wireit": {
    "build": {
      "command": "tsc",
      "dependencies": ["../other-package:build"]
    }
  }
}
```
