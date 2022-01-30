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
  | /** A cycle in the task graph. */ 'cycle'
  | /** A task process exited with a non-zero exit code. */ 'task-failed'
  | /** A task aborted because of a user signal. */ 'task-cancelled'
  | /** An error spawning or communicating with a task. */ 'task-control-error'
  | /** A task could not be found in a package.json wireit config. */ 'task-not-found';
