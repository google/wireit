/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const markdownIt = require('markdown-it');
const markdownItAnchor = require('markdown-it-anchor');

module.exports = function (eleventyConfig) {
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

  return {
    pathPrefix: '/wireit/',
    dir: {
      input: 'content',
    },
  };
};
