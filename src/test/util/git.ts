/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {execFileSync} from 'child_process';

export const git = (cwd: string, args: string[]) => {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
};

export const initRepo = (dir: string) => {
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'wireit@example.com']);
  git(dir, ['config', 'user.name', 'Wireit Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
};
