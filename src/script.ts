/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ArrayNode, JsonAstNode, NamedAstNode} from './util/ast.js';
import {JsonFile} from './util/package-json-reader.js';

/**
 * The location on disk of an npm package.
 */
export interface PackageReference {
  /** Absolute path to an npm package directory. */
  packageDir: string;
}

/**
 * The name and package location of a script.
 */
export interface ScriptReference extends PackageReference {
  /** A concrete script name (no ./ or $WORKSPACES etc.) */
  name: string;
}

/**
 * The name and location of a script, along with its full configuration.
 */
export interface ScriptConfig extends ScriptReference {
  /**
   * The shell command to execute.
   *
   * An undefined command is valid as a way to give name to a group of other
   * scripts (specified as dependencies).
   */
  command: JsonAstNode<string> | undefined;

  /**
   * Scripts that must run before this one.
   *
   * Note that the {@link Analyzer} returns dependencies sorted by package
   * directory + script name, but the {@link Executor} then randomizes the order
   * during execution.
   */
  dependencies: ScriptConfig[];
  dependenciesAst: JsonAstNode | undefined;

  /**
   * Input file globs for this script.
   *
   * If undefined, the input files are unknown (meaning the script cannot safely
   * be cached). If defined but empty, there are no input files (meaning the
   * script can safely be cached).
   */
  files: ArrayNode<string> | undefined;

  /**
   * Output file globs for this script.
   */
  output: ArrayNode<string> | undefined;

  /**
   * When to clean output:
   *
   * - true: Before the script executes, and before restoring from cache.
   * - false: Before restoring from cache.
   * - "if-file-deleted": If an input file has been deleted, and before restoring from
   *   cache.
   */
  clean: boolean | 'if-file-deleted';

  /**
   * The command string in the scripts section. i.e.:
   *
   * ```json
   *   "scripts": {
   *     "build": "tsc"
   *              ~~~~
   *   }
   * ```
   */
  scriptAstNode: NamedAstNode<string>;

  /**
   * The entire config in the wireit section. i.e.:
   *
   * ```json
   *   "build": {
   *            ~
   *     "command": "tsc"
   *   ~~~~~~~~~~~~~~~~~~
   *   }
   *   ~
   * ```
   */
  configAstNode: NamedAstNode | undefined;

  /** The parsed JSON file that declared this script. */
  declaringFile: JsonFile;
}

/**
 * Convert a {@link ScriptReference} to a string that can be used as a key in a
 * Set, Map, etc.
 */
export const scriptReferenceToString = ({
  packageDir,
  name,
}: ScriptReference): ScriptReferenceString =>
  JSON.stringify([packageDir, name]) as ScriptReferenceString;

/**
 * Inverse of {@link scriptReferenceToString}.
 */
export const stringToScriptReference = (
  str: ScriptReferenceString
): ScriptReference => {
  const [packageDir, name] = JSON.parse(str) as [string, string];
  return {packageDir, name};
};

/**
 * Brand that ensures {@link stringToScriptReference} only takes strings that
 * were returned by {@link scriptReferenceToString}.
 */
export type ScriptReferenceString = string & {
  __ScriptReferenceStringBrand__: never;
};

/**
 * All meaningful input state of a script. Used for determining if a script is
 * fresh, and as the key for storing cached output.
 */
export interface ScriptState {
  /**
   * Whether the output for this script can be fresh or cached.
   *
   * True only if the "files" array was defined for this script, and for all of
   * this script's transitive dependencies.
   */
  cacheable: boolean;

  /** E.g. linux, win32 */
  platform: NodeJS.Platform;

  /** E.g. x64 */
  arch: string;

  /** E.g. 16.7.0 */
  nodeVersion: string;

  /**
   * The shell command from the Wireit config.
   */
  command: string | undefined;

  /**
   * The "clean" setting from the Wireit config.
   *
   * This is included in the cache key because switching from "false" to "true"
   * could produce different output, so a re-run should be triggered even if
   * nothing else changed.
   */
  clean: boolean | 'if-file-deleted';

  // Must be sorted.
  files: {[packageDirRelativeFilename: string]: Sha256HexDigest};

  /**
   * The "output" glob patterns from the Wireit config.
   *
   * This is included in the cache key because changing the output patterns
   * could produce different output when "clean" is true, and because it affects
   * which files get included in a cache entry.
   *
   * Note the undefined vs empty-array distinction is not meaningful here,
   * because both cases cause no files to be deleted, and the undefined case is
   * never cached anyway.
   */
  output: string[];

  // Must be sorted.
  dependencies: {[dependency: ScriptReferenceString]: ScriptState};
}

/**
 * String serialization of a {@link ScriptState}.
 */
export type ScriptStateString = string & {
  __ScriptStateStringBrand__: never;
};

/**
 * SHA256 hash hexadecimal digest of a file's content.
 */
export type Sha256HexDigest = string & {
  __Sha256HexDigestBrand__: never;
};
