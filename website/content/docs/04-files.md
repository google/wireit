---
layout: docs.njk
title: Files
permalink: docs/files/index.html
eleventyNavigation:
  key: Files
  order: 4
---

## Input and output files

The `files` and `output` properties of `wireit.<script>` tell Wireit what your
script's input and output files are, respectively. They should be arrays of
[glob patterns](../reference/#glob-patterns), where paths are interpreted relative to the
package directory. They can be set on some, all, or none of your scripts.

Setting these properties allow you to use more features of Wireit:

|                                                | Requires<br>`files` | Requires<br>`output` |
| ---------------------------------------------: | :-----------------: | :------------------: |
|       [**Dependency graph**](../dependencies/) |          -          |          -           |
| [**Incremental build**](../incremental-build/) |         ☑️          |          -           |
|                    [**Watch mode**](../watch/) |         ☑️          |          -           |
|                [**Clean build**](../cleaning/) |          -          |          ☑️          |
|                     [**Caching**](../caching/) |         ☑️          |          ☑️          |

#### Example configuration

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
      "output": ["lib/**"]
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
