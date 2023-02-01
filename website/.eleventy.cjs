/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const markdownIt = require('markdown-it');
const markdownItAnchor = require('markdown-it-anchor');
const pathlib = require('path');
const {EleventyRenderPlugin} = require('@11ty/eleventy');

module.exports = function (eleventyConfig) {
  eleventyConfig.addPlugin(EleventyRenderPlugin);
  eleventyConfig.addPlugin(require('@11ty/eleventy-navigation'));
  eleventyConfig.addPlugin(require('@11ty/eleventy-plugin-syntaxhighlight'));

  eleventyConfig.addPassthroughCopy({
    'content/_static': '.',
    [require.resolve('prism-themes/themes/prism-ghcolors.css')]:
      'prism-light.css',
    [require.resolve('prism-themes/themes/prism-atom-dark.css')]:
      'prism-dark.css',
  });

  eleventyConfig.setLibrary(
    'md',
    markdownIt({
      html: true,
    }).use(markdownItAnchor, {
      level: 3,
      permalink: markdownItAnchor.permalink.headerLink(),
    })
  );

  /**
   * Generate a relative path to the root from the given page URL.
   *
   * Useful when a template which is used from different directories needs to
   * reliably refer to a path with a relative URL, so that the site can be
   * served from different sub-directories.
   *
   * Example:
   *   /         --> .
   *   /foo/     --> ..
   *   /foo/bar/ --> ../..
   *
   * (It sort of seems like this should be built-in. There's the "url" filter,
   *  but it produces paths that don't depend on the current URL).
   */
  eleventyConfig.addFilter('relativePathToRoot', (url) =>
    url === '/' ? '.' : pathlib.posix.relative(url, '/')
  );

  return {
    dir: {
      input: 'content',
    },
  };
};
