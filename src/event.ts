/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {UnvalidatedConfig} from './analyzer.js';
import {Diagnostic} from './error.js';
import type {
  ScriptConfig,
  ScriptReference,
  PackageReference,
} from './config.js';

/**
 * Something that happened during Wireit execution. Includes successes,
 * failures, script output, and purely informational events.
 *
 * Events are presented to users by a {@link Logger}.
 */
export type Event = Success | Failure | Output | Info;

interface EventBase<T extends PackageReference> {
  script: T;
  diagnostic?: Diagnostic;
  diagnostics?: Diagnostic[];
}

// -------------------------------
// Success events
// -------------------------------

type Success = ExitZero | NoCommand | Fresh | Cached;

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

/**
 * A script was already fresh so it didn't need to execute.
 */
export interface Fresh extends SuccessBase<ScriptConfig> {
  reason: 'fresh';
}

/**
 * Script output was restored from cache.
 */
export interface Cached extends SuccessBase<ScriptConfig> {
  reason: 'cached';
}

// -------------------------------
// Failure events
// -------------------------------

export type Failure =
  | ExitNonZero
  | ExitSignal
  | SpawnError
  | StartCancelled
  | Killed
  | LaunchedIncorrectly
  | MissingPackageJson
  | NoScriptsSectionInPackageJson
  | PackageJsonParseError
  | ScriptNotFound
  | WireitScriptNotInScriptsSection
  | ScriptNotWireit
  | InvalidConfigSyntax
  | InvalidUsage
  | DuplicateDependency
  | DependencyOnMissingPackageJson
  | DependencyOnMissingScript
  | Cycle
  | UnknownErrorThrown
  | DependencyOnMissingPackageJson
  | DependencyOnMissingScript
  | DependencyInvalid;

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
 * We decided not to start a script after all, due to e.g. another script
 * failure.
 */
export interface StartCancelled extends ErrorBase<ScriptReference> {
  reason: 'start-cancelled';
}

/**
 * A script was intentionally and successfully killed by Wireit.
 */
export interface Killed extends ErrorBase<ScriptReference> {
  reason: 'killed';
}

/**
 * Wireit was launched incorrectly (e.g. directly or via "npx", instead of via
 * "npm run").
 */
export interface LaunchedIncorrectly extends ErrorBase<PackageReference> {
  reason: 'launched-incorrectly';
  detail: string;
}

/**
 * The package.json file could not be found.
 */
export interface MissingPackageJson extends ErrorBase<PackageReference> {
  reason: 'missing-package-json';
}

/**
 * The package.json file was invalid JSON.
 */
export interface PackageJsonParseError extends ErrorBase<PackageReference> {
  reason: 'invalid-json-syntax';
  diagnostics: Diagnostic[];
}

/**
 * The package.json doesn't have a "scripts" object at all.
 */
export interface NoScriptsSectionInPackageJson
  extends ErrorBase<ScriptReference> {
  reason: 'no-scripts-in-package-json';
}

/**
 * The specified script does not exist in a package.json.
 */
export interface ScriptNotFound extends ErrorBase<ScriptReference> {
  reason: 'script-not-found';
  diagnostic: Diagnostic;
}

/**
 * The specified script has a wireit config, but it isn't declared in the
 * scripts section at all.
 */
export interface WireitScriptNotInScriptsSection
  extends ErrorBase<ScriptReference> {
  reason: 'wireit-config-but-no-script';
  diagnostic: Diagnostic;
}

/**
 * The specified script's command is not "wireit".
 */
export interface ScriptNotWireit extends ErrorBase<ScriptReference> {
  reason: 'script-not-wireit';
  diagnostic: Diagnostic;
}

/**
 * Something is syntactically wrong with the wireit config.
 */
export interface InvalidConfigSyntax extends ErrorBase<PackageReference> {
  reason: 'invalid-config-syntax';
  diagnostic: Diagnostic;
}

export interface InvalidUsage extends ErrorBase<ScriptReference> {
  reason: 'invalid-usage';
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
  diagnostic: Diagnostic;
}

/**
 * A script depends on another in a package that isn't there.
 */
export interface DependencyOnMissingPackageJson
  extends ErrorBase<ScriptReference> {
  reason: 'dependency-on-missing-package-json';
  diagnostic: Diagnostic;
  /**
   * This is a better error message than the missing-package-json error,
   * so if we'd be going to display both, we should only display this one.
   */
  supercedes: Failure;
}

/**
 * A script's dependency doesn't exist.
 */
export interface DependencyOnMissingScript extends ErrorBase<ScriptReference> {
  reason: 'dependency-on-missing-script';
  diagnostic: Diagnostic;
  supercedes: ScriptNotFound;
}

/**
 * We reached the point of doing cyclic dependency checking, and one of our
 * transitive dependencies had not transitioned to being locally validated.
 * This should generally only happen if we ignored the diagnostics after
 * analyzing, and is potentially a sign of an internal error in our logic.
 *
 * The IdeAnalyzer will reach this point normally however, because it will
 * continue to cycle detection even when some diagnostics were generated during
 * local analysis.
 */
export interface DependencyInvalid extends ErrorBase<ScriptReference> {
  reason: 'dependency-invalid';
  dependency: UnvalidatedConfig;
}

/**
 * The dependency graph has a cycle in it.
 */
export interface Cycle extends ErrorBase<ScriptReference> {
  reason: 'cycle';

  diagnostic: Diagnostic;
}

/**
 * For when we catch an error not handled by any of the other types.
 */
export interface UnknownErrorThrown extends ErrorBase<ScriptReference> {
  reason: 'unknown-error-thrown';
  error: unknown;
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

type Info =
  | ScriptRunning
  | ScriptLocked
  | OutputModified
  | WatchRunStart
  | WatchRunEnd
  | GenericInfo;

interface InfoBase<T extends ScriptReference> extends EventBase<T> {
  type: 'info';
}

/**
 * A script's command started running.
 */
export interface ScriptRunning extends InfoBase<ScriptConfig> {
  detail: 'running';
}

/**
 * A script can't run right now because a system-wide lock is being held by
 * another process.
 */
export interface ScriptLocked extends InfoBase<ScriptConfig> {
  detail: 'locked';
}

/**
 * A script that would otherwise have been skipped as fresh is being treated as
 * stale, because one or more output files from the previous run have been
 * added, removed, or changed.
 */
export interface OutputModified extends InfoBase<ScriptConfig> {
  detail: 'output-modified';
}

/**
 * A watch mode iteration started.
 */
export interface WatchRunStart extends InfoBase<ScriptReference> {
  detail: 'watch-run-start';
}

/**
 * A watch mode iteration ended.
 */
export interface WatchRunEnd extends InfoBase<ScriptReference> {
  detail: 'watch-run-end';
}

/**
 * A generic info event.
 */
export interface GenericInfo extends InfoBase<ScriptReference> {
  detail: 'generic';
  message: string;
}
