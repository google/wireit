/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Node as AstNodeInternal,
  JSONPath,
  findNodeAtLocation as findNodeAtLocationInternal,
  parseTree as parseTreeInternal,
  ParseError,
} from 'jsonc-parser';
import {PlaceholderConfig} from '../analyzer.js';
import {WireitError} from '../error.js';
export {ParseError} from 'jsonc-parser';

type ValueTypes = string | number | boolean | null | undefined;

/**
 * A JSON AST node.
 *
 * A safer override, preferring unknown over any.
 */
export interface AstNode<T extends ValueTypes = ValueTypes>
  extends AstNodeInternal {
  value: T;
  children?: AstNode[];
  parent?: AstNode<undefined>;
}

export interface ArrayNode<T> {
  readonly node: AstNode;
  readonly values: T[];
}

/**
 * A JSON value that is inside an object literal, and that has a reference
 * to its key in that object.
 */
export interface NamedAstNode<T extends ValueTypes = ValueTypes>
  extends AstNode<T> {
  /**
   * If `this` represents:
   * ```json
   *     "key": "value",
   *            ~~~~~~~
   * ```
   *
   * Then this name represents:
   * ```json
   *     "key": "value",
   *     ~~~~~
   * ```
   */
  name: AstNode;
}

export function findNamedNodeAtLocation(
  astNode: AstNode,
  path: JSONPath,
  script: PlaceholderConfig
): NamedAstNode | undefined {
  const node = findNodeAtLocation(astNode, path) as NamedAstNode | undefined;
  const parent = node?.parent;
  if (node === undefined || parent === undefined) {
    return undefined;
  }
  const name = parent.children?.[0];
  if (parent.type !== 'property' || name == null) {
    throw new WireitError({
      type: 'failure',
      reason: 'invalid-config-syntax',
      message: `Expected a property, but got a ${parent.type}`,
      astNode: parent,
      script,
    });
  }
  node.name = name;
  return node;
}

export function findNodeAtLocation(
  astNode: AstNode,
  path: JSONPath
): AstNode | undefined {
  return findNodeAtLocationInternal(astNode, path) as AstNode;
}

export function parseTree(
  json: string,
  placeholder: PlaceholderConfig
): AstNode {
  const errors: ParseError[] = [];
  const result = parseTreeInternal(json, []);
  if (errors.length > 0) {
    throw new WireitError({
      type: 'failure',
      reason: 'invalid-json-syntax',
      errors,
      script: placeholder,
    });
  }
  return result as AstNode;
}
