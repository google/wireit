/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
  command: string | undefined;

  /**
   * Scripts that must run before this one.
   *
   * Note that the {@link Analyzer} returns dependencies sorted by package
   * directory + script name, but the {@link Executor} then randomizes the order
   * during execution.
   */
  dependencies: ScriptConfig[];

  /**
   * Input file globs for this script.
   *
   * If undefined, the input files are unknown (meaning the script cannot safely
   * be cached). If defined but empty, there are no input files (meaning the
   * script can safely be cached).
   */
  files: string[] | undefined;
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
export interface CacheKey {
  command: string | undefined;
  // Must be sorted.
  files: {[packageDirRelativeFilename: string]: Sha256HexDigest};
  // Must be sorted.
  dependencies: {[dependency: ScriptReferenceString]: CacheKey};
}

/**
 * String serialization of a {@link CacheKey}.
 */
export type CacheKeyString = string & {
  __CacheKeyStringBrand__: never;
};

/**
 * SHA256 hash hexadecimal digest of a file's content.
 */
export type Sha256HexDigest = string & {
  __Sha256HexDigest__: never;
};
