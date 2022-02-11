/**
 * A fixed-size pool of reservations. The reservations can represent any
 * resource.
 *
 * Once the maximum number of reservations have been reserved, the next caller
 * must wait until a reservation is released back to the pool.
 */
export class ReservationPool {
  private readonly _size: number;
  private readonly _waiting: Array<() => void> = [];
  private _numReserved = 0;

  /**
   * @param size The maximum number of reservations that can be held at once.
   */
  constructor(size: number) {
    if (size < 1) {
      throw new Error('ReservationPool size must be >= 1');
    }
    this._size = size;
  }

  /**
   * Wait until a reservation is free.
   *
   * @returns A function that returns the reservation back to the pool so that
   * it can be claimed by another caller.
   */
  async reserve(): Promise<() => void> {
    if (this._numReserved >= this._size) {
      await new Promise<void>((resolve) => this._waiting.push(resolve));
    }
    this._numReserved++;
    let released = false;
    return () => {
      if (released) {
        throw new Error('ReservationPool reservation already released');
      }
      released = true;
      this._numReserved--;
      this._waiting.shift()?.();
    };
  }
}
