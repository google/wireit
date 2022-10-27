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
  private _sigintIntercepted = false;

  constructor(socket: net.Socket) {
    super(socket);
    process.on('SIGINT', () => {
      // Don't exit if the rig is going to call exit manually.
      if (!this._sigintIntercepted) {
        this._closeSocketAndExit(0);
      }
    });
  }

  protected override _onMessage(message: RigToChildMessage): void {
    switch (message.type) {
      case 'exit': {
        this._closeSocketAndExit(message.code);
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
      case 'interceptSigint': {
        this._sigintIntercepted = true;
        process.on('SIGINT', () => {
          this._send({type: 'sigintReceived'});
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

  /**
   * Gracefully close the socket before and exit. This helps avoid occasional
   * ECONNRESET errors on the other side.
   */
  private _closeSocketAndExit(code: number) {
    socket.end(() => {
      process.exit(code);
    });
  }
}

const ipcPath = process.argv[2];
if (!ipcPath) {
  console.error('Error: expected first argument to be a socket/pipe filename.');
  process.exit(1);
}
const socket = net.createConnection(ipcPath);
new ChildIpcClient(socket);
