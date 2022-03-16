/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

// This module is invoked whenever a WireitTestRigCommand child process is
// spawned.

import * as net from 'net';
import {unreachable} from '../../util/unreachable.js';
import {
  type Message,
  MESSAGE_END_MARKER,
} from './test-rig-command-interface.js';

const ipcPath = process.argv[2];
if (!ipcPath) {
  console.error('Error: expected first argument to be a socket/pipe filename.');
  process.exit(1);
}

const client = net.createConnection(ipcPath);

let messageBuffer = '';

/**
 * Handle some message data from the parent rig.
 *
 * Note that each data event could contain a partial message, or multiple
 * messages. The special MESSAGE_END_MARKER character is used to detect the end
 * of each complete JSON message in the stream.
 */
client.on('data', (data: Buffer) => {
  for (const char of data.toString()) {
    if (char === MESSAGE_END_MARKER) {
      const message = JSON.parse(messageBuffer) as Message;
      messageBuffer = '';
      handleMessage(message);
    } else {
      messageBuffer += char;
    }
  }
});

const handleMessage = (message: Message): void => {
  switch (message.type) {
    default: {
      console.error(
        `Unhandled message type ${(unreachable(message) as Message).type}`
      );
      process.exit(1);
      break;
    }
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
  }
};
