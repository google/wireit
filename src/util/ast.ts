/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as jsonParser from 'jsonc-parser';
import {parseTree as parseTreeInternal, ParseError} from 'jsonc-parser';
import {PlaceholderConfig} from '../analyzer.js';
import {Result, Diagnostic} from '../error.js';
import {Failure} from '../event.js';
import {JsonFile} from './package-json-reader.js';
export {ParseError} from 'jsonc-parser';

type ValueTypes = string | number | boolean | null | undefined;

/**
 * A JSON AST node.
 *
 * A safer override, preferring unknown over any.
 */
export interface JsonAstNode<T extends ValueTypes = ValueTypes>
  extends Readonly<jsonParser.Node> {
  readonly value: T;
  readonly children?: JsonAstNode[];
  readonly parent?: JsonAstNode<undefined>;
}

/**
 * An extended JSON AST node for an array of values.
 *
 * We do this to avoid mutating the JsonAstNodes, which are produced by the
 * parser, and only have primitive values.
 */
export interface ArrayNode<T> {
  readonly node: JsonAstNode;
  readonly values: T[];
}

/**
 * A JSON value that is inside an object literal, and that has a reference
 * to its key in that object.
 */
export interface NamedAstNode<T extends ValueTypes = ValueTypes>
  extends JsonAstNode<T> {
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
  name: JsonAstNode;
}

export function findNamedNodeAtLocation(
  astNode: JsonAstNode,
  path: jsonParser.JSONPath,
  script: PlaceholderConfig,
  file: JsonFile
): Result<NamedAstNode | undefined> {
  const node = findNodeAtLocation(astNode, path) as NamedAstNode | undefined;
  const parent = node?.parent;
  if (node === undefined || parent === undefined) {
    return {ok: true, value: undefined};
  }
  const name = parent.children?.[0];
  if (parent.type !== 'property' || name == null) {
    return {
      ok: false,
      error: {
        type: 'failure',
        reason: 'invalid-config-syntax',
        script,
        diagnostic: {
          severity: 'error',
          message: `Expected a property, but got a ${parent.type}`,
          location: {
            file,
            range: {offset: astNode.offset, length: astNode.length},
          },
        },
      },
    };
  }
  node.name = name;
  return {ok: true, value: node};
}

export function findNodeAtLocation(
  astNode: JsonAstNode,
  path: jsonParser.JSONPath
): JsonAstNode | undefined {
  return jsonParser.findNodeAtLocation(astNode, path) as
    | JsonAstNode
    | undefined;
}

export function parseTree(
  filePath: string,
  json: string,
  placeholder: PlaceholderConfig
): Result<JsonAstNode, Failure> {
  const errors: ParseError[] = [];
  const result = parseTreeInternal(json, errors);
  if (errors.length > 0) {
    const diagnostics: Diagnostic[] = errors.map((error) => ({
      severity: 'error',
      message: `JSON syntax error`,
      location: {
        file: {
          path: filePath,
          contents: json,
          ast: result as JsonAstNode,
        },
        range: {
          offset: error.offset,
          length: error.length,
        },
      },
    }));
    return {
      ok: false,
      error: {
        type: 'failure',
        reason: 'invalid-json-syntax',
        diagnostics,
        script: placeholder,
      },
    };
  }
  return {ok: true, value: result as JsonAstNode};
}
