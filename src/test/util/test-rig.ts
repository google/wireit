import * as path from 'path';
import {fileURLToPath} from 'url';
import * as net from 'net';
import * as fs from 'fs/promises';
import {spawn} from 'child_process';

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

  async readFile(filename: string): Promise<string> {
    const absolute = path.resolve(this._filesTempDir, filename);
    return fs.readFile(absolute, 'utf8');
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
      Object.entries(process.env).filter(([k]) => !k.startsWith('npm_'))
    );
    const child = spawn(command, [], {
      cwd,
      shell: true,
      detached: true,
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      // process.stdout.write(chunk);
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      // process.stderr.write(chunk);
      stderr += chunk;
    });
    let running = true;
    const close = new Promise<{stdout: string; stderr: string; code: number}>(
      (resolve) => {
        child.on('exit', (code) => {
          running = false;
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
  private _resolveConnectionPromise!: (socket: net.Socket) => void;
  private _connectionPromise: Promise<net.Socket>;
  private _running = false;
  private _startedCount = 0;
  private _nextSignal: Promise<string>;
  private _nextSignalResolve!: (signal: string) => void;

  constructor(socketfile: string) {
    this._socketfile = socketfile;
    this._server = net.createServer(this._onConnection);
    fs.mkdir(path.dirname(socketfile), {recursive: true}).then(() => {
      this._server.listen(this._socketfile);
    });
    this._connectionPromise = new Promise((resolve) => {
      this._resolveConnectionPromise = resolve;
    });
    this._nextSignal = new Promise((resolve) => {
      this._nextSignalResolve = resolve;
    });
  }

  command(): string {
    return `SOCKETFILE=${this._socketfile} node ${__filename}`;
  }

  async waitUntilStarted(): Promise<void> {
    await this._connectionPromise;
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
    const connection = await this._connectionPromise;
    connection.write(String(code));
    this._running = false;
    this._connectionPromise = new Promise((resolve) => {
      this._resolveConnectionPromise = resolve;
    });
  }

  async close(): Promise<void> {
    await this._server.close();
  }

  get receivedSignal() {
    return this._nextSignal;
  }

  private readonly _onConnection = (socket: net.Socket) => {
    if (this._running) {
      throw new Error('Unexpected multiple simultaneous command invocations.');
    }
    this._running = true;
    this._startedCount++;
    socket.on('data', (data) => {
      const signal = data.toString();
      this._nextSignalResolve(signal);
      this._nextSignal = new Promise((resolve) => {
        this._nextSignalResolve = resolve;
      });
    });
    this._resolveConnectionPromise(socket);
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
