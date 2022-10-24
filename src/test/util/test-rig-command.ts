/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as net from 'net';
import * as pathlib from 'path';
import {fileURLToPath} from 'url';
import {Deferred} from '../../util/deferred.js';
import {unreachable} from '../../util/unreachable.js';
import {
  IpcClient,
  RigToChildMessage,
  ChildToRigMessage,
  EnvironmentResponseMessage,
} from './test-rig-command-interface.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathlib.dirname(__filename);
const childModulePath = pathlib.resolve(__dirname, 'test-rig-command-child.js');

/**
 * A unique command which allows us to monitor each time it has been spawned and
 * control when it exits. Takes the place of what would be build programs like
 * "tsc", "rollup" in a real configuration.
 *
 * Instances of this class should be created via the
 * {@link WireitTestRig.command} method.
 */
export class WireitTestRigCommand {
  private readonly _ipcPath: string;
  private readonly _server: net.Server;
  private _state: 'uninitialized' | 'listening' | 'closed' = 'uninitialized';
  private _allConnections: Array<net.Socket> = [];
  private _newConnections: Array<net.Socket> = [];
  private _newConnectionNotification = new Deferred<void>();

  constructor(socketfile: string) {
    this._ipcPath = socketfile;
    this._server = net.createServer(this._onConnection);
  }

  private _assertState(expected: 'uninitialized' | 'listening' | 'closed') {
    if (this._state !== expected) {
      throw new Error(
        `Expected state to be ${expected} but was ${this._state}`
      );
    }
  }

  /**
   * Start listening for connections on the configured socketfile.
   */
  async listen(): Promise<void> {
    this._assertState('uninitialized');
    this._state = 'listening';
    return new Promise((resolve, reject) => {
      this._server.listen(this._ipcPath);
      this._server.on('listening', () => resolve());
      this._server.on('error', (error: Error) => reject(error));
    });
  }

  /**
   * Stop listening for connections.
   */
  async close(): Promise<void> {
    this._assertState('listening');
    this._state = 'closed';
    // The server won't close until all connections are destroyed.
    for (const connection of this._allConnections) {
      connection.destroy();
    }
    return new Promise((resolve, reject) => {
      this._server.close((error: Error | undefined) => {
        if (error !== undefined) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Generate a shell command which will invoke the child Node module,
   * configured to connect to this command's socketfile.
   */
  get command(): string {
    return `node ${childModulePath} ${this._ipcPath}`;
  }

  /**
   * How many invocations of this command were made.
   */
  get numInvocations(): number {
    return this._allConnections.length;
  }

  /**
   * Wait for the next invocation of this command. Note that the same command
   * can be invoked multiple times simultaneously.
   */
  async nextInvocation(): Promise<WireitTestRigCommandInvocation> {
    this._assertState('listening');
    while (true) {
      const socket = this._newConnections.shift();
      if (socket !== undefined) {
        return new WireitTestRigCommandInvocation(socket, this);
      }
      await this._newConnectionNotification.promise;
    }
  }

  /**
   * A child connected to our socketfile.
   */
  private readonly _onConnection = (socket: net.Socket) => {
    this._assertState('listening');
    this._allConnections.push(socket);
    this._newConnections.push(socket);
    this._newConnectionNotification.resolve();
    this._newConnectionNotification = new Deferred();
  };
}

/**
 * One invocation of a {@link WireitTestRigCommand}.
 */
export class WireitTestRigCommandInvocation extends IpcClient<
  ChildToRigMessage,
  RigToChildMessage
> {
  readonly command: WireitTestRigCommand;
  private _state: 'connected' | 'closing' | 'closed' = 'connected';
  private _environmentResponse?: Deferred<EnvironmentResponseMessage>;

  constructor(socket: net.Socket, command: WireitTestRigCommand) {
    super(socket);
    this.command = command;
    void this.closed.then(() => {
      this._state = 'closed';
    });
  }

  private _assertState(expected: 'connected' | 'closing' | 'closed') {
    if (this._state !== expected) {
      throw new Error(
        `Expected state to be ${expected} but was ${this._state}`
      );
    }
  }

  protected override _onMessage(message: ChildToRigMessage): void {
    switch (message.type) {
      case 'environmentResponse': {
        if (
          this._environmentResponse === undefined ||
          this._environmentResponse.settled
        ) {
          throw new Error('Unexpected environmentResponse');
        }
        this._environmentResponse.resolve(message);
        break;
      }
      default: {
        throw new Error(
          `Unhandled message type ${String(unreachable(message.type))}`
        );
        break;
      }
    }
  }

  environment(): Promise<Exclude<EnvironmentResponseMessage, 'type'>> {
    this._assertState('connected');
    // TODO(aomarks) If we end up with a more complex API, we might want to
    // create a proper RPC system with unique IDs for each request that can be
    // used to map specific responses back to specific requests. But for now our
    // API is very basic and doesn't require that.
    if (this._environmentResponse === undefined) {
      this._environmentResponse = new Deferred();
      this._send({type: 'environmentRequest'});
    }
    return this._environmentResponse.promise;
  }

  /**
   * Promise that resolves when this invocation's socket has exited, indicating
   * that the process has exited (or is just about to exit).
   */
  get closed(): Promise<void> {
    return this._closed.promise;
  }

  /**
   * Return whether this invocation is still running.
   */
  get running(): boolean {
    return this._state === 'connected';
  }

  /**
   * Tell this invocation to exit with the given code.
   */
  exit(code: number): void {
    this._assertState('connected');
    this._send({type: 'exit', code});
    this._state = 'closing';
  }

  /**
   * Tell this invocation to write the given string to its stdout stream.
   */
  stdout(str: string): void {
    this._assertState('connected');
    this._send({type: 'stdout', str});
  }

  /**
   * Tell this invocation to write the given string to its stderr stream.
   */
  stderr(str: string): void {
    this._assertState('connected');
    this._send({type: 'stderr', str});
  }
}
