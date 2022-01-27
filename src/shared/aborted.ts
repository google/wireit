export const Aborted = Symbol('aborted');

/**
 *
 */
export class AbortManager {
  private _pending = 0;

  private _notification!: Promise<void>;
  private _notify!: () => void;

  private readonly _aborted: Promise<typeof Aborted>;
  private _abortedResolve!: (aborted: typeof Aborted) => void;

  constructor() {
    this._aborted = new Promise((resolve) => {
      this._abortedResolve = resolve;
    });
    this._resetNotification();
  }

  private _resetNotification() {
    this._notification = new Promise((resolve) => {
      this._notify = resolve;
    });
  }

  get aborted(): Promise<typeof Aborted> {
    return this._aborted;
  }

  increment() {
    this._pending++;
  }

  decrement() {
    this._pending--;
    this._notify();
    this._resetNotification();
  }

  async abort(): Promise<void> {
    this._abortedResolve(Aborted);
    while (this._pending > 0) {
      await this._notification;
    }
  }
}
