/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TypeScript will error if it believes this function could be invoked. Useful
 * to check for branches that should never be reached (e.g. that all possible
 * cases in a switch are handled).
 */
export const unreachable = (value: never) => value;
