/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A message sent between a Wireit test rig instance and a spawned test rig
 * command.
 */
export type Message = StdoutMessage | StderrMessage | ExitMessage;

/**
 * Indicates the end of a JSON message on an IPC data stream. This is the
 * "record separator" ASCII character.
 */
export const MESSAGE_END_MARKER = '\x1e';

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
