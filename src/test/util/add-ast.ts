/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AstNode, parseTree} from '../../util/ast.js';
import {astKey} from '../../util/package-json-reader.js';

export function addAst<T extends object>(
  jsonObject: T
): T & {[astKey]: AstNode} {
  const asString = JSON.stringify(jsonObject);
  const ast = parseTree(asString, {
    name: `fake-testing-script`,
    packageDir: `fake-testing-dir`,
  });
  if (ast === undefined) {
    throw new Error(`Failed to parse JSON: ${asString}`);
  }
  return {...jsonObject, [astKey]: ast};
}
