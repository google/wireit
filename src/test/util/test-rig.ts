import * as path from 'path';
import {fileURLToPath} from 'url';
import * as net from 'net';
import * as fs from 'fs/promises';
import {exec} from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tempRoot = path.resolve(__dirname, '..', '..', '..', 'temp');

export class TestRig {
  private readonly _tempDir = path.join(tempRoot, String(Math.random()));
  private readonly _socketsTempDir = path.join(this._tempDir, 'sockets');
  private readonly _filesTempDir = path.join(this._tempDir, 'files');
  private readonly _commands: Array<Command> = [];
  private _nextCommandId = 0;
  private _done = false;

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

  async exec(
    command: string
  ): Promise<{stdout: string; stderr: string; code: number}> {
    this._checkNotDone();
    return new Promise((resolve) => {
      exec(command, {cwd: this._filesTempDir}, (error, stdout, stderr) =>
        resolve({stdout, stderr, code: error?.code ?? 0})
      );
    });
  }

  async cleanup(): Promise<void> {
    this._checkNotDone();
    this._done = true;
    await Promise.all(this._commands.map((command) => command.close()));
    return fs.rm(this._tempDir, {recursive: true});
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private _checkNotDone() {
    if (this._done) {
      throw new Error('TestRig has already finished');
    }
  }
}

class Command {
  private readonly _socketfile: string;
  private readonly _server: net.Server;
  private _resolveFirstConnection!: (socket: net.Socket) => void;
  private _firstConnection: Promise<net.Socket>;
  private _running = false;
  private _startedCount = 0;

  constructor(socketfile: string) {
    this._socketfile = socketfile;
    this._firstConnection = new Promise((resolve) => {
      this._resolveFirstConnection = resolve;
    });
    this._server = net.createServer(this._onConnection);
    fs.mkdir(path.dirname(socketfile), {recursive: true}).then(() => {
      this._server.listen(this._socketfile);
    });
  }

  command(): string {
    return `SOCKETFILE=${this._socketfile} node ${__filename}`;
  }

  async waitUntilStarted(): Promise<void> {
    await this._firstConnection;
  }

  get running(): boolean {
    return this._running;
  }

  get startedCount(): number {
    return this._startedCount;
  }

  async exit(code: number): Promise<void> {
    const connection = await this._firstConnection;
    connection.write(String(code));
    this._running = false;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this._server.close(() => resolve());
    });
  }

  private readonly _onConnection = (socket: net.Socket) => {
    this._running = true;
    this._startedCount++;
    this._resolveFirstConnection(socket);
  };
}

const socketfile = process.env.SOCKETFILE;
if (socketfile) {
  const client = net.createConnection(socketfile);
  client.on('data', (data: Buffer) => {
    const code = Number(data.toString());
    process.exit(code);
  });
}
