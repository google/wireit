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
  | /** A script aborted because of a user signal. */ 'script-cancelled'
  | /** An error spawning or communicating with a script. */ 'script-control-error'
  | /** A script could not be found in a package.json wireit config. */ 'script-not-found';
