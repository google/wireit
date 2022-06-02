/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// This module is invoked whenever a WireitTestRigCommand child process is
// spawned.

import * as net from 'net';
import {unreachable} from '../../util/unreachable.js';
import {
  IpcClient,
  ChildToRigMessage,
  RigToChildMessage,
} from './test-rig-command-interface.js';

const ipcPath = process.argv[2];
if (!ipcPath) {
  console.error('Error: expected first argument to be a socket/pipe filename.');
  process.exit(1);
}

const socket = net.createConnection(ipcPath);
const client = new IpcClient<RigToChildMessage, ChildToRigMessage>(socket);

for await (const message of client.receive()) {
  switch (message.type) {
    case 'exit': {
      process.exit(message.code);
      break;
    }
    case 'stdout': {
      process.stdout.write(message.str);
      break;
    }
    case 'stderr': {
      process.stderr.write(message.str);
      break;
    }
    default: {
      console.error(
        `Unhandled message type ${
          (unreachable(message) as RigToChildMessage).type
        }`
      );
      process.exit(1);
      break;
    }
  }
}
