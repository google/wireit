/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {appendFileSync} from 'fs';

const requireEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
};

// Writing to this file sets environment variables for all subsequent steps in
// the user's workflow. Reference:
// https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions#setting-an-environment-variable
const GITHUB_ENV = requireEnv('GITHUB_ENV');

// The next 2 environment variables are automatically provided to custom
// workflows like this one, but not to regular "run" steps. By writing these
// variables to the GITHUB_ENV file, we make them available to the user's "run"
// steps, and hence to all Wireit invocations.

// URL for the GitHub Actions cache service.
const ACTIONS_CACHE_URL = requireEnv('ACTIONS_CACHE_URL');

// A secret token for authenticating to the GitHub Actions cache service.
//
// This is a JWT which _appears_ to have limited scope, so we believe that the
// risk of exposing this variable to all workflow steps is low. See
// https://github.com/actions/toolkit/issues/1053 for more discussion.
//
// See also https://github.com/google/wireit/issues/107 for discussion about how
// we might refactor out GitHub Actions caching support to address this and
// other issues. In particular, we could potentially start an HTTP server in
// this action to act as a proxy for this token so that it doesn't need to be
// shared to all workflow steps.
const ACTIONS_RUNTIME_TOKEN = requireEnv('ACTIONS_RUNTIME_TOKEN');

// URL needed by @actions/artifact package.
const ACTIONS_RUNTIME_URL = requireEnv('ACTIONS_RUNTIME_URL');

appendFileSync(
  GITHUB_ENV,
  `
WIREIT_CACHE=github
ACTIONS_CACHE_URL=${ACTIONS_CACHE_URL}
ACTIONS_RUNTIME_TOKEN=${ACTIONS_RUNTIME_TOKEN}
ACTIONS_RUNTIME_URL=${ACTIONS_RUNTIME_URL}
`
);
