/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Force module.
export {};

// The AbortSignal type defined in @types/node does not have an addEventListener
// method. See
// https://github.com/DefinitelyTyped/DefinitelyTyped/discussions/57805.

// TODO(aomarks) Contribute this type, and remove this interface after
// @types/node are updated.

declare global {
  interface AbortSignal {
    addEventListener(
      type: 'abort',
      listener: (event: {type: 'abort'}) => void,
      options?: {once?: boolean}
    ): boolean;
  }
}
