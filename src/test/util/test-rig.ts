/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import * as path from 'path';
import {fileURLToPath} from 'url';
import * as net from 'net';
import * as fs from 'fs/promises';
import {spawn, type ChildProcess} from 'child_process';
import {Deferred} from '../../shared/deferred.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tempRoot = path.resolve(__dirname, '..', '..', '..', 'temp');

export class TestRig {
  readonly tempDir = path.join(tempRoot, String(Math.random()));
  private readonly _socketsTempDir = path.join(this.tempDir, 'sockets');
  private readonly _filesTempDir = path.join(this.tempDir, 'files');
  private readonly _commands: Array<Command> = [];
  private readonly _activeChildProcesses = new Set<ChildProcess>();
  private _nextCommandId = 0;
  private _done = false;

  async setup() {
    await fs.mkdir(path.join(this.tempDir, 'node_modules', '.bin'), {
      recursive: true,
    });
    await fs.symlink(
      '../../../../bin/wireit.js',
      path.join(this.tempDir, 'node_modules', '.bin', 'wireit')
    );
  }

  newCommand(): Command {
    this._checkNotDone();
    const command = new Command(
      path.join(this._socketsTempDir, `${this._nextCommandId++}.sock`)
    );
    this._commands.push(command);
    return command;
  }

  async writeFiles(files: {[filename: string]: unknown}) {
    this._checkNotDone();
    await Promise.all(
      Object.entries(files).map(async ([relative, data]) => {
        const absolute = path.resolve(this._filesTempDir, relative);
        await fs.mkdir(path.dirname(absolute), {recursive: true});
        const str =
          typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        return fs.writeFile(absolute, str, 'utf8');
      })
    );
  }

  async symlink(target: string, file: string): Promise<void> {
    const absolute = path.resolve(this._filesTempDir, file);
    try {
      await fs.unlink(absolute);
    } catch (err) {
      if ((err as {code?: string}).code !== 'ENOENT') {
        throw err;
      }
      await fs.mkdir(path.dirname(absolute), {recursive: true});
    }
    console.log('symlink', {target, absolute});
    await fs.symlink(target, absolute);
  }

  async rmFile(filename: string): Promise<void> {
    const absolute = path.resolve(this._filesTempDir, filename);
    return fs.rm(absolute, {force: true, recursive: true});
  }

  async readFile(filename: string): Promise<string> {
    const absolute = path.resolve(this._filesTempDir, filename);
    return fs.readFile(absolute, 'utf8');
  }

  async fileExists(filename: string): Promise<boolean> {
    const absolute = path.resolve(this._filesTempDir, filename);
    try {
      await fs.access(absolute);
      return true;
    } catch (err) {
      if ((err as {code?: string}).code === 'ENOENT') {
        return false;
      }
      throw err;
    }
  }

  async chmod(file: string, mode: Parameters<typeof fs.chmod>[1]) {
    const absolute = path.resolve(this._filesTempDir, file);
    return fs.chmod(absolute, mode);
  }

  exec(
    command: string,
    opts?: {cwd?: string}
  ): {
    kill: (signal: string | number) => void;
    done: Promise<{stdout: string; stderr: string; code: number}>;
    running: () => boolean;
  } {
    this._checkNotDone();
    const cwd = path.resolve(this._filesTempDir, opts?.cwd ?? '.');

    // TODO(aomarks) We need this to isolate npm environment variable context
    // that is inherited from the script that's used to run the wireit tests.
    // Should we be doing something like this within wireit itself, too?
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !k.startsWith('npm_') && k !== 'GITHUB_CACHE'
      )
    );
    const child = spawn(command, [], {
      cwd,
      shell: true,
      detached: true,
      env,
    });
    this._activeChildProcesses.add(child);
    let stdout = '';
    let stderr = '';
    const showOutput = process.env.SHOW_OUTPUT;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (showOutput) {
        process.stdout.write(chunk);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (showOutput) {
        process.stderr.write(chunk);
      }
    });
    let running = true;
    const close = new Promise<{stdout: string; stderr: string; code: number}>(
      (resolve) => {
        child.on('exit', (code) => {
          running = false;
          this._activeChildProcesses.delete(child);
          // Code will be null when the process was killed via a signal. 130 is
          // the conventional return code used in this case.
          // TODO(aomarks) We should probably signal vs code explicitly.
          resolve({stdout, stderr, code: code ?? 130});
        });
      }
    );
    const kill = (signal: string | number) => process.kill(-child.pid!, signal);
    return {done: close, kill, running: () => running};
  }

  async cleanup(): Promise<void> {
    this._checkNotDone();
    this._done = true;
    await Promise.all(this._commands.map((command) => command.close()));
    for (const process of this._activeChildProcesses) {
      process.kill(9);
    }
    return fs.rm(this.tempDir, {recursive: true});
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Returns a promise that resolves to whichever command next starts up.
   */
  nextCmdStart(): Promise<Command> {
    return Promise.race(
      this._commands.map((command) =>
        command.waitUntilStarted().then(() => command)
      )
    );
  }

  /**
   * Create a {@link CommandPool} with all of the commands created on this rig
   * so far.
   */
  pool(): CommandPool {
    return new CommandPool(this._commands);
  }

  private _checkNotDone() {
    if (this._done) {
      throw new Error('TestRig has already finished');
    }
  }
}

/**
 * A pool of commands which could start in any order, with metrics to help test
 * how many are pending/running/done at any given time.
 */
class CommandPool {
  private readonly _pending: Set<Command>;
  private readonly _running = new Set<Command>();
  private readonly _done = new Set<Command>();

  constructor(commands: Command[]) {
    this._pending = new Set(commands);
    for (const cmd of commands) {
      cmd.waitUntilStarted().then(() => {
        this._pending.delete(cmd);
        this._running.add(cmd);
        cmd.exited.then(() => {
          this._running.delete(cmd);
          this._done.add(cmd);
        });
      });
    }
  }

  next(): Promise<Command> {
    return Promise.race(
      [...this._pending].map((cmd) => cmd.waitUntilStarted().then(() => cmd))
    );
  }

  get counts(): {pending: number; running: number; done: number} {
    return {
      pending: this._pending.size,
      running: this._running.size,
      done: this._done.size,
    };
  }
}

class Command {
  private readonly _socketfile: string;
  private readonly _server: net.Server;
  private _connection = new Deferred<net.Socket>();
  private _running = false;
  private _startedCount = 0;
  private _nextSignal = new Deferred<string>();
  private _nextExit = new Deferred<void>();

  constructor(socketfile: string) {
    this._socketfile = socketfile;
    this._server = net.createServer(this._onConnection);
    fs.mkdir(path.dirname(socketfile), {recursive: true}).then(() => {
      this._server.listen(this._socketfile);
    });
  }

  command(): string {
    return `SOCKETFILE=${this._socketfile} node ${__filename}`;
  }

  async waitUntilStarted(): Promise<void> {
    await this._connection.promise;
  }

  get running(): boolean {
    return this._running;
  }

  get startedCount(): number {
    return this._startedCount;
  }

  async exit(code: number): Promise<void> {
    if (!this.running) {
      throw new Error('Command is not running; cannot exit.');
    }
    const connection = await this._connection.promise;
    connection.write(String(code));
    this._running = false;
    this._connection = new Deferred();
    this._nextExit.resolve();
    this._nextExit = new Deferred();
  }

  get exited(): Promise<void> {
    return this._nextExit.promise;
  }

  async close(): Promise<void> {
    await this._server.close();
  }

  get receivedSignal() {
    return this._nextSignal.promise;
  }

  private readonly _onConnection = (socket: net.Socket) => {
    if (this._running) {
      throw new Error('Unexpected multiple simultaneous command invocations.');
    }
    this._running = true;
    this._startedCount++;
    socket.on('data', (data) => {
      const signal = data.toString();
      this._nextSignal.resolve(signal);
      this._nextSignal = new Deferred();
    });
    this._connection.resolve(socket);
  };
}

const socketfile = process.env.SOCKETFILE;
if (socketfile) {
  const client = net.createConnection(socketfile);
  process.on('SIGINT', async () => {
    client.write('SIGINT');
  });
  client.on('data', (data: Buffer) => {
    const code = Number(data.toString());
    process.exit(code);
  });
}
