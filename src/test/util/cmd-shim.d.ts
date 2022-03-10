/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

// TODO(aomarks) Update the types at
// https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/cmd-shim,
// which still have an older callback API, instead of the newer Promise API.

declare module 'cmd-shim' {
  export default function cmdShim(from: string, to: string): Promise<void>;
}
