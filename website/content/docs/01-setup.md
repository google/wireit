---
layout: docs.njk
title: Setup
permalink: docs/setup/index.html
eleventyNavigation:
  key: Setup
  order: 1
---

## Setup

### Install

```bash
npm i -D wireit
```

### Setup

Wireit works _with_ `npm run`, it doesn't replace it. To configure an NPM script
for Wireit, move the command into a new `wireit` section of your `package.json`,
and replace the original script with the `wireit` command.

<table>
<tr>
<th>Before</th>
<th>After</th>
</tr>
<tr>
<td>

```json
{
  "scripts": {
    "build": "tsc"
  }
}
```

</td>
<td>

```json
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
```

</td>
</tr>
</table>

Now when you run `npm run build`, Wireit upgrades the script to be smarter and
more efficient. Wireit works with [yarn](https://yarnpkg.com/) and
[pnpm](https://pnpm.io/), too.

You should also add `.wireit` to your `.gitignore` file. Wireit uses the
`.wireit` directory to store caches and other data for your scripts.

```bash
echo .wireit >> .gitignore
```

### VSCode Extension

If you use VSCode, consider installing the `google.wireit` extension. It adds documentation on hover, autocomplete, can diagnose a number of common mistakes, and even suggest a refactoring to convert an npm script to use wireit.

Install it [from the marketplace](https://marketplace.visualstudio.com/items?itemName=google.wireit) or on the command line like:

```bash
code --install-extension google.wireit
```
