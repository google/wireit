/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A cache for values that are asynchronously computed that ensures that we
 * will compute the value for each key at most once.
 */
export class AsyncCache<K, V> {
  readonly #cache = new Map<K, Promise<V>>();

  async getOrCompute(key: K, compute: () => Promise<V>): Promise<V> {
    let result = this.#cache.get(key);
    if (result === undefined) {
      result = compute();
      this.#cache.set(key, result);
    }
    return result;
  }
}
