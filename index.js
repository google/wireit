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

// URL for the GitHub Actions cache service, and a token for authenticating to
// it. These environment variables are automatically provided to custom
// workflows like this one, but not to regular "run" steps. By writing these
// variables to the GITHUB_ENV file, we make them available to the user's "run"
// steps, and hence to all Wireit invocations.
const ACTIONS_CACHE_URL = requireEnv('ACTIONS_CACHE_URL');
const ACTIONS_RUNTIME_TOKEN = requireEnv('ACTIONS_RUNTIME_TOKEN');

appendFileSync(
  GITHUB_ENV,
  `
WIREIT_CACHE=github
ACTIONS_CACHE_URL=${ACTIONS_CACHE_URL}
ACTIONS_RUNTIME_TOKEN=${ACTIONS_RUNTIME_TOKEN}
`
);
