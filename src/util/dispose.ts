/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Quick dispose polyfills.
type Writeable<T> = {-readonly [P in keyof T]: T[P]};

if (!Symbol.dispose) {
  (Symbol as Writeable<typeof Symbol>).dispose = Symbol(
    'dispose',
  ) as typeof Symbol.dispose;
}
if (!Symbol.asyncDispose) {
  (Symbol as Writeable<typeof Symbol>).asyncDispose = Symbol(
    'asyncDispose',
  ) as typeof Symbol.asyncDispose;
}

export {};
