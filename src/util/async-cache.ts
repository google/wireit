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
  private readonly _cache = new Map<K, Promise<V>>();

  async getOrCompute(key: K, compute: () => Promise<V>): Promise<V> {
    let result = this._cache.get(key);
    if (result === undefined) {
      result = compute();
      this._cache.set(key, result);
    }
    return result;
  }

  get values() {
    return this._cache.values();
  }
}
