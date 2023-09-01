/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Quick Symbol.dispose polyfill.
if (!Symbol.dispose) {
  type Writeable<T> = {-readonly [P in keyof T]: T[P]};
  (Symbol as Writeable<typeof Symbol>).dispose = Symbol(
    'dispose',
  ) as typeof Symbol.dispose;
}

export {};
