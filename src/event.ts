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
  ScriptReferenceWithCommand,
  PackageReference,
} from './config.js';

/**
 * Something that happened during Wireit execution. Includes successes,
 * failures, script output, and purely informational events.
 *
 * Events are presented to users by a {@link Logger}.
 */
export type Event = Success | Failure | Output | Info;

interface EventBase<T extends PackageReference = ScriptReference> {
  script: T;
  diagnostic?: Diagnostic;
  diagnostics?: Diagnostic[];
}

// -------------------------------
// Success events
// -------------------------------

/**
 * A script finished successfully.
 */
export type Success = ExitZero | NoCommand | Fresh | Cached;

interface SuccessBase<T extends PackageReference = ScriptReference>
  extends EventBase<T> {
  type: 'success';
}

/**
 * A script finished with exit code 0.
 */
export interface ExitZero extends SuccessBase {
  reason: 'exit-zero';
}

/**
 * A script completed because it had no command and its dependencies completed.
 */
export interface NoCommand extends SuccessBase {
  reason: 'no-command';
}

/**
 * A script was already fresh so it didn't need to execute.
 */
export interface Fresh extends SuccessBase {
  reason: 'fresh';
}

/**
 * Script output was restored from cache.
 */
export interface Cached extends SuccessBase {
  reason: 'cached';
}

// -------------------------------
// Failure events
// -------------------------------

/**
 * A problem was encountered.
 */
export type Failure =
  | ExitNonZero
  | ExitSignal
  | SpawnError
  | StartCancelled
  | FailedPreviousWatchIteration
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
  | DependencyInvalid
  | ServiceExitedUnexpectedly
  | DependencyServiceExitedUnexpectedly
  | Aborted;

interface ErrorBase<T extends PackageReference = ScriptReference>
  extends EventBase<T> {
  type: 'failure';
  logged?: true;
}

/**
 * A script finished with an exit status that was not 0.
 */
export interface ExitNonZero extends ErrorBase {
  reason: 'exit-non-zero';
  status: number;
}

/**
 * A script exited because of a signal it received.
 */
export interface ExitSignal extends ErrorBase {
  reason: 'signal';
  signal: NodeJS.Signals;
}

/**
 * An error occured trying to spawn a script's command.
 */
export interface SpawnError extends ErrorBase {
  reason: 'spawn-error';
  message: string;
}

/**
 * We decided not to start a script after all, due to e.g. another script
 * failure.
 */
export interface StartCancelled extends ErrorBase {
  reason: 'start-cancelled';
}

/**
 * A script failed on the previous watch iteration, and its fingerprint hasn't
 * changed, so it was skipped.
 */
export interface FailedPreviousWatchIteration extends ErrorBase {
  reason: 'failed-previous-watch-iteration';
}

/**
 * A script was intentionally and successfully killed by Wireit.
 */
export interface Killed extends ErrorBase {
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
export interface NoScriptsSectionInPackageJson extends ErrorBase {
  reason: 'no-scripts-in-package-json';
}

/**
 * The specified script does not exist in a package.json.
 */
export interface ScriptNotFound extends ErrorBase {
  reason: 'script-not-found';
  diagnostic: Diagnostic;
}

/**
 * The specified script has a wireit config, but it isn't declared in the
 * scripts section at all.
 */
export interface WireitScriptNotInScriptsSection extends ErrorBase {
  reason: 'wireit-config-but-no-script';
  diagnostic: Diagnostic;
}

/**
 * The specified script's command is not "wireit".
 */
export interface ScriptNotWireit extends ErrorBase {
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

export interface InvalidUsage extends ErrorBase {
  reason: 'invalid-usage';
  message: string;
}

/**
 * A script lists the same dependency multiple times.
 */
export interface DuplicateDependency extends ErrorBase {
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
export interface DependencyOnMissingPackageJson extends ErrorBase {
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
export interface DependencyOnMissingScript extends ErrorBase {
  reason: 'dependency-on-missing-script';
  diagnostic: Diagnostic;
  supercedes: ScriptNotFound;
}

/**
 * A service exited before it was supposed to.
 */
export interface ServiceExitedUnexpectedly extends ErrorBase {
  reason: 'service-exited-unexpectedly';
}

/**
 * A service that we depend on exited before it was supposed to, causing us to
 * fail as well.
 */
export interface DependencyServiceExitedUnexpectedly extends ErrorBase {
  reason: 'dependency-service-exited-unexpectedly';
}

/**
 * A script was killed or is refusing to run because it was intentionally
 * aborted. Usually due to an error occuring in another script somewhere.
 */
export interface Aborted extends ErrorBase {
  reason: 'aborted';
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
export interface DependencyInvalid extends ErrorBase {
  reason: 'dependency-invalid';
  dependency: UnvalidatedConfig;
}

/**
 * The dependency graph has a cycle in it.
 */
export interface Cycle extends ErrorBase {
  reason: 'cycle';

  diagnostic: Diagnostic;
}

/**
 * For when we catch an error not handled by any of the other types.
 */
export interface UnknownErrorThrown extends ErrorBase {
  reason: 'unknown-error-thrown';
  error: unknown;
}

// -------------------------------
// Output events
// -------------------------------

/**
 * A script emitted output.
 */
export type Output = Stdout | Stderr;

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

/**
 * Something happened, neither success nor failure, though often progress.
 */
export type Info =
  | ScriptRunning
  | ScriptLocked
  | OutputModified
  | WatchRunStart
  | WatchRunEnd
  | WatchAborted
  | WatchedFileTriggeredRun
  | ServiceProcessStarted
  | ServiceReady
  | ServiceStopped
  | AnalysisStarted
  | AnalysisCompleted
  | CacheInfo;

interface InfoBase<T extends PackageReference = ScriptReference>
  extends EventBase<T> {
  type: 'info';
}

/**
 * A script's command started running.
 */
export interface ScriptRunning extends InfoBase<ScriptReferenceWithCommand> {
  detail: 'running';
}

/**
 * A script can't run right now because a system-wide lock is being held by
 * another process.
 */
export interface ScriptLocked extends InfoBase {
  detail: 'locked';
}

/**
 * A script that would otherwise have been skipped as fresh is being treated as
 * stale, because one or more output files from the previous run have been
 * added, removed, or changed.
 */
export interface OutputModified extends InfoBase {
  detail: 'output-modified';
}

/**
 * The analysis phase for a run has begun, where we load package.json
 * files, analyze their wireit configs, and build the dependency graph.
 */
export interface AnalysisStarted extends InfoBase {
  detail: 'analysis-started';
}

/**
 * The analysis phase for a run has completed. If successful, we have a
 * rootScriptConfig with a full dependency graph. If unsuccessful, it is
 * undefined, and there will be a Failure event with more information.
 */
export interface AnalysisCompleted extends InfoBase {
  detail: 'analysis-completed';
  rootScriptConfig: undefined | ScriptConfig;
}

/**
 * A watch mode iteration started.
 */
export interface WatchRunStart extends InfoBase {
  detail: 'watch-run-start';
  reason: WatchRunStartReason;
}

export type WatchRunStartReason =
  | {name: 'initial'}
  | {name: 'file-changed'; path: string; operation: FileOperation};

/**
 * A watch mode iteration ended.
 */
export interface WatchRunEnd extends InfoBase {
  detail: 'watch-run-end';
}

/**
 * We're exiting from watch mode.
 */
export interface WatchAborted extends InfoBase {
  detail: 'watch-aborted';
  reason: WatchAbortedReason;
}

export type WatchAbortedReason = /** We received a CTRL-C signal. */ 'SIGINT';

/**
 * A file changed that we're watching, and that triggered the next
 * watch-run-start.
 */
export interface WatchedFileTriggeredRun extends InfoBase {
  detail: 'watched-file-triggered-run';
  path: string;
  operation: FileOperation;
  /**
   * true if we noticed the file was changed while a run was active.
   */
  runActive: boolean;
}

export type FileOperation = 'changed' | 'created' | 'deleted' | 'altered in an unknown way';

/**
 * A service process started running.
 */
export interface ServiceProcessStarted extends InfoBase {
  detail: 'service-process-started';
}

/**
 * A service started running and if it has a readyWhen condition,
 * that condition is met.
 */
export interface ServiceReady extends InfoBase {
  detail: 'service-ready';
}

/**
 * A service stopped running.
 */
export interface ServiceStopped extends InfoBase {
  detail: 'service-stopped';
}

/**
 * An advisory event about caching.
 */
export interface CacheInfo extends InfoBase {
  detail: 'cache-info';
  message: string;
}
