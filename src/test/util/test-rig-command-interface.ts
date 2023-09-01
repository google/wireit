/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as net from 'net';
import {Deferred} from '../../util/deferred.js';

/**
 * A message sent from the test rig to a spawned command.
 */
export type RigToChildMessage =
  | StdoutMessage
  | StderrMessage
  | ExitMessage
  | EnvironmentRequestMessage
  | InterceptSigintMessage;

/**
 * Tell the command to emit the given string to its stdout stream.
 */
export interface StdoutMessage {
  type: 'stdout';
  str: string;
}

/**
 * Tell the command to emit the given string to its stderr stream.
 */
export interface StderrMessage {
  type: 'stderr';
  str: string;
}

/**
 * Tell the command to exit with the given code.
 */
export interface ExitMessage {
  type: 'exit';
  code: number;
}

/**
 * The the command to wait until a SIGINT signal is received, and then send a
 * messsage back instead of exiting.
 */
export interface InterceptSigintMessage {
  type: 'interceptSigint';
}

/**
 * Ask the command for information about its environment (argv, cwd, env).
 */
export interface EnvironmentRequestMessage {
  type: 'environmentRequest';
}

/**
 * A message sent from a spawned command to the test rig.
 */
export type ChildToRigMessage =
  | EnvironmentResponseMessage
  | SigintReceivedMessage;

/**
 * Report to the rig what cwd, argv, and environment variables were set when
 * Wireit spawned this command.
 */
export interface EnvironmentResponseMessage {
  type: 'environmentResponse';
  cwd: string;
  argv: string[];
  env: {[key: string]: string | undefined};
}

/**
 * Report the rig that a SIGINT signal has been received.
 */
export interface SigintReceivedMessage {
  type: 'sigintReceived';
}

/**
 * Indicates the end of a JSON message on an IPC data stream. This is the
 * "record separator" ASCII character.
 */
export const MESSAGE_END_MARKER = '\x1e';

/**
 * Sends and receives messages over an IPC data stream.
 */
export abstract class IpcClient<Incoming, Outgoing> {
  readonly #socket: net.Socket;
  protected readonly _closed = new Deferred<void>();
  #incomingDataBuffer = '';

  constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.on('data', this.#onData);
    socket.once('close', () => {
      this._closed.resolve();
      socket.removeListener('data', this.#onData);
    });
  }

  protected _send(message: Outgoing): void {
    if (this._closed.settled) {
      throw new Error('Connection is closed');
    }
    this.#socket.write(JSON.stringify(message));
    this.#socket.write(MESSAGE_END_MARKER);
  }

  protected abstract _onMessage(message: Incoming): void;

  /**
   * Handle an incoming message.
   *
   * Note that each data event could contain a partial message, or multiple
   * messages. The special MESSAGE_END_MARKER character is used to detect the end
   * of each complete JSON message in the stream.
   */
  #onData = (data: Buffer) => {
    if (this._closed.settled) {
      throw new Error('Connection is closed');
    }
    for (const char of data.toString()) {
      if (char === MESSAGE_END_MARKER) {
        const message = JSON.parse(this.#incomingDataBuffer) as Incoming;
        this.#incomingDataBuffer = '';
        this._onMessage(message);
      } else {
        this.#incomingDataBuffer += char;
      }
    }
  };
}
