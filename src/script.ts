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
}

/**
 * Convert a {@link ScriptReference} to a string that can be used as a key in a
 * Set, Map, etc.
 */
export const configReferenceToString = ({
  packageDir,
  name,
}: ScriptReference): ScriptReferenceString =>
  JSON.stringify([packageDir, name]) as ScriptReferenceString;

/**
 * Inverse of {@link configReferenceToString}.
 */
export const stringToConfigReference = (
  str: ScriptReferenceString
): ScriptReference => {
  const [packageDir, name] = JSON.parse(str) as [string, string];
  return {packageDir, name};
};

/**
 * Brand that ensures {@link stringToConfigReference} only takes strings that
 * were returned by {@link configReferenceToString}.
 */
export type ScriptReferenceString = string & {
  __ScriptReferenceStringBrand__: never;
};
