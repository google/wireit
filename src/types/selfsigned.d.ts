/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Typings for https://github.com/jfromaniello/selfsigned which are not
// available in DefinitelyTyped.

declare module 'selfsigned' {
  export function generate(attrs: Array<{name: string; value: string}>): {
    cert: string;
    public: string;
    private: string;
  };
}
