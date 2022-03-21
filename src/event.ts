/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import type {
  ScriptConfig,
  ScriptReference,
  PackageReference,
} from './script.js';

/**
 * Something that happened during Wireit execution. Includes successes,
 * failures, script output, and purely informational events.
 *
 * Events are presented to users by a {@link Logger}.
 */
export type Event = Success | Failure | Output | Info;

interface EventBase<T extends PackageReference> {
  script: T;
}

// -------------------------------
// Success events
// -------------------------------

type Success = ExitZero | NoCommand;

interface SuccessBase<T extends PackageReference> extends EventBase<T> {
  type: 'success';
}

/**
 * A script finished with exit code 0.
 */
export interface ExitZero extends SuccessBase<ScriptConfig> {
  reason: 'exit-zero';
}

/**
 * A script completed because it had no command and its dependencies completed.
 */
export interface NoCommand extends SuccessBase<ScriptConfig> {
  reason: 'no-command';
}

// -------------------------------
// Failure events
// -------------------------------

export type Failure =
  | ExitNonZero
  | ExitSignal
  | SpawnError
  | LaunchedIncorrectly
  | MissingPackageJson
  | InvalidPackageJson
  | ScriptNotFound
  | ScriptNotWireit
  | InvalidConfigSyntax
  | DuplicateDependency
  | Cycle;

interface ErrorBase<T extends PackageReference> extends EventBase<T> {
  type: 'failure';
}

/**
 * A script finished with an exit status that was not 0.
 */
export interface ExitNonZero extends ErrorBase<ScriptConfig> {
  reason: 'exit-non-zero';
  status: number;
}

/**
 * A script exited because of a signal it received.
 */
export interface ExitSignal extends ErrorBase<ScriptConfig> {
  reason: 'signal';
  signal: NodeJS.Signals;
}

/**
 * An error occured trying to spawn a script's command.
 */
export interface SpawnError extends ErrorBase<ScriptReference> {
  reason: 'spawn-error';
  message: string;
}

/**
 * Wireit was launched incorrectly (e.g. directly or via "npx", instead of via
 * "npm run").
 */
export interface LaunchedIncorrectly extends ErrorBase<PackageReference> {
  reason: 'launched-incorrectly';
}

/**
 * The package.json file could not be found.
 */
export interface MissingPackageJson extends ErrorBase<ScriptReference> {
  reason: 'missing-package-json';
}

/**
 * A package.json file was invalid.
 */
export interface InvalidPackageJson extends ErrorBase<ScriptReference> {
  reason: 'invalid-package-json';
}

/**
 * The specified script does not exist in a package.json.
 */
export interface ScriptNotFound extends ErrorBase<ScriptReference> {
  reason: 'script-not-found';
}

/**
 * The specified script's command is not "wireit".
 */
export interface ScriptNotWireit extends ErrorBase<ScriptReference> {
  reason: 'script-not-wireit';
}

/**
 * Something is syntactically wrong with the wireit config.
 */
export interface InvalidConfigSyntax extends ErrorBase<ScriptReference> {
  reason: 'invalid-config-syntax';
  message: string;
}

/**
 * A script lists the same dependency multiple times.
 */
export interface DuplicateDependency extends ErrorBase<ScriptReference> {
  reason: 'duplicate-dependency';
  /**
   * The dependency that is duplicated.
   */
  dependency: ScriptReference;
}

/**
 * The dependency graph has a cycle in it.
 */
export interface Cycle extends ErrorBase<ScriptReference> {
  reason: 'cycle';

  /**
   * The number of edges in the cycle (e.g. "A -> B -> A" is 2).
   */
  length: number;

  /**
   * The walk that was taken that resulted in the cycle being detected, starting
   * from the root script.
   */
  trail: ScriptReference[];
}

// -------------------------------
// Output events
// -------------------------------

type Output = Stdout | Stderr;

interface OutputBase extends EventBase<ScriptConfig> {
  type: 'output';
  data: Buffer | string;
}

/**
 * A script's spawned process emitted a chunk of data to standard out.
 */
export interface Stdout extends OutputBase {
  stream: 'stdout';
}

/**
 * A script's spawned process emitted a chunk of data to standard error.
 */
export interface Stderr extends OutputBase {
  stream: 'stderr';
}

// -------------------------------
// Informational events
// -------------------------------

type Info = ScriptRunning;

interface InfoBase extends EventBase<ScriptConfig> {
  type: 'info';
}

/**
 * A script's command started running.
 */
export interface ScriptRunning extends InfoBase {
  detail: 'running';
}
