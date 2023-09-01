/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A map that can also efficiently return the most recently added entry.
 */
export class StackMap<K, V> extends Map<K, V> {
  readonly #stack: Array<[K, V]> = [];

  override set(key: K, value: V) {
    if (!this.has(key)) {
      this.#stack.push([key, value]);
    }
    return super.set(key, value);
  }

  // Surprisingly, we don't need to override delete, because we expect peek()
  // to be called frequently, and it will remove any trailing deleted entries.

  /**
   * Returns the most recently added entry that's still in the map, or
   * undefined if the map is empty.
   */
  peek(): [K, V] | undefined {
    while (true) {
      const last = this.#stack[this.#stack.length - 1];
      if (!last) {
        return;
      }
      if (this.has(last[0])) {
        return last;
      }
      this.#stack.pop();
    }
  }
}
