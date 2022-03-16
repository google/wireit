/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

/**
 * The location on disk of an npm package.
 */
export interface PackageReference {
  /** Absolute path to an npm package directory. */
  package: string;
}

/**
 * The name and package location of a script.
 */
export interface ScriptReference extends PackageReference {
  /** A concrete script name (no ./ or $WORKSPACES etc.) */
  script: string;
}

/**
 * The name and package location of a script, along with its parents.
 */
export interface ScriptReferenceWithParents extends ScriptReference {
  /**
   * The script(s) in the dependency graph that are inbound to this one. Helpful
   * for understanding the path(s) taken to reach a script.
   */
  parents: Script[];
}

/**
 * The name and location of a script, along with its parents, and its full
 * configuration.
 */
export interface Script extends ScriptReferenceWithParents {
  /**
   * The shell command to execute.
   *
   * An undefined command is valid as a way to give name to a group of other
   * scripts (specified as dependencies).
   */
  command?: string;
  /** Scripts that must run before this one. */
  dependencies: Array<Script>;
}
