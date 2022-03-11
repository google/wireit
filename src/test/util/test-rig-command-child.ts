/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

// This module is invoked whenever a WireitTestRigCommand child process is
// spawned.

import * as net from 'net';

const ipcPath = process.argv[2];
if (!ipcPath) {
  console.error('Error: expected first argument to be a socket/pipe filename.');
  process.exit(1);
}

const client = net.createConnection(ipcPath);

/**
 * Handle a message sent from the parent to this child over the socketfile.
 *
 * The message protocol is trivial: any message is assumed to be an exit code
 * that we should immediately exit with.
 */
client.on('data', (data: Buffer) => {
  const code = Number(data.toString());
  process.exit(code);
});
