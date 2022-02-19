// An error we expect and don't print a stack trace for.
export class KnownError extends Error {
  private readonly _code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this._code = code;
  }

  get code() {
    return this._code;
  }
}

export type ErrorCode =
  | /** A user error. */ 'invalid-argument'
  | /** A cycle in the script graph. */ 'cycle'
  | /** A script process exited with a non-zero exit code. */ 'script-failed'
  | /** A script aborted because of a signal that we did not expect. */ 'script-cancelled-unexpectedly'
  | /** A script aborted because of a signal that we sent. */ 'script-cancelled-intentionally'
  | /** An error spawning or communicating with a script. */ 'script-control-error'
  | /** A script could not be found in a package.json wireit config. */ 'script-not-found'
  | /** A script was configured in the "wireit" section, but not the "scripts" section. */ 'missing-npm-script'
  | /** A script was configured in the "wireit" section, and it's in the "scripts" section, but the "scripts" command is not "wireit". */ 'misconfigured-npm-script'
  | /** Something is wrong about a script's wireit configuration. */ 'misconfigured';
