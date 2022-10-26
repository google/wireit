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

class ChildIpcClient extends IpcClient<RigToChildMessage, ChildToRigMessage> {
  protected override _onMessage(message: RigToChildMessage): void {
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
      case 'environmentRequest': {
        this._send({
          type: 'environmentResponse',
          cwd: process.cwd(),
          argv: process.argv,
          env: process.env,
        });
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
}

const ipcPath = process.argv[2];
if (!ipcPath) {
  console.error('Error: expected first argument to be a socket/pipe filename.');
  process.exit(1);
}
const socket = net.createConnection(ipcPath);
new ChildIpcClient(socket);

process.on('SIGINT', () => {
  // Gracefully close the socket before we are terminated. This helps avoid
  // occasional ECONNRESET errors on the other side.
  socket.end(() => {
    process.exit(1);
  });
});
