---
layout: layout.njk
title: Parallelism
permalink: parallelism/index.html
eleventyNavigation:
  key: Parallelism
  order: 3
---

## Parallelism

Wireit will run scripts in parallel whenever it is safe to do so according to
the dependency graph.

For example, in this diagram, the `B` and `C` scripts will run in parallel,
while the `A` script won't start until both `B` and `C` finish.

{% comment %}

<!-- The diagram below was generated at https://mermaid.live/
     and manually edited to follow prefers-color-scheme. -->
<!-- prettier-ignore-start -->
graph TD
  A-->B;
  A-->C;
  subgraph parallel
    B;
    C;
  end
<!-- prettier-ignore-end -->

{% endcomment %}

<img src ="../images/parallel-diagram.svg" height="204" width="198">

By default, Wireit will run up to 2 scripts in parallel for every CPU thread
detected on your system. To change this default, set the `WIREIT_PARALLEL`
[environment variable](../reference/#environment-variables) to a positive integer, or
`infinity` to run without a limit. You may want to lower this number if you
experience resource starvation in large builds. For example, to run only one
script at a time:

```bash
export WIREIT_PARALLEL=1
npm run build
```

If two or more seperate `npm run` commands are run for the same Wireit script
simultaneously, then only one instance will be allowed to run at a time, while
the others wait their turn. This prevents coordination problems that can result
in incorrect output files being produced. If `output` is set to an empty array,
then this restriction is removed.
