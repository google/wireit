import {ResolvedScriptReference} from '../types/config.js';

export type Event =
  | Success
  | Failure
  | Output
  /* Other events */
  | DependenciesPending
  | DependenciesResolved
  | CacheMiss
  | ParallelContention
  | OutputDeleted
  | IncrementalDelegation
  | Spawn
  | CacheSave
  | Killing;

interface ScriptEventBase {
  script: ResolvedScriptReference;
}

// -------------------------------
// Success events
// -------------------------------

type Success = Fresh | NoCommand | CacheHit | ExitZero;

interface SuccessBase extends ScriptEventBase {
  type: 'success';
}

/**
 * A script is already fresh, so it will be skipped entirely.
 */
export interface Fresh extends SuccessBase {
  reason: 'fresh';
}

/**
 * A script completed because it had no command and its dependencies were
 * resolved.
 */
export interface NoCommand extends SuccessBase {
  reason: 'no-command';
}

/**
 * A script's output was copied from the cache.
 */
export interface CacheHit extends SuccessBase {
  reason: 'cache-hit';
}

/**
 * A script's spawned process exited with status code 0.
 */
export interface ExitZero extends SuccessBase {
  reason: 'exit-zero';
  elapsedMs: number;
}

// -------------------------------
// Failure events
// -------------------------------

type Failure = StartError | ExitNonZero | Interrupt | Cycle;

interface FailureBase extends ScriptEventBase {
  type: 'failure';
}

/**
 * A script failed to spawn the process for its command.
 */
export interface StartError extends FailureBase {
  reason: 'start-error';
  message: string;
}

/**
 * A script's spawned process exited with a non-zero status code.
 */
export interface ExitNonZero extends FailureBase {
  reason: 'exit-non-zero';
  code: number;
}

/**
 * A script's spawned process exited because of a signal it received.
 */
export interface Interrupt extends FailureBase {
  reason: 'interrupt';
  signal: NodeJS.Signals;
  /**
   * True if wireit intentionally sent a signal to kill this process (e.g.
   * because another script failed and we are in --fail-fast mode). False if it
   * was unexpected.
   */
  intentional: boolean;
}

/**
 * A script could not run because it has a cycle in its dependency graph.
 */
export interface Cycle extends FailureBase {
  reason: 'cycle';
}

// -------------------------------
// Output events
// -------------------------------

type Output = Stdout | Stderr;

interface OutputBase extends ScriptEventBase {
  type: 'output';
  data: Buffer | string;
}

/**
 * A script's spawned process emitted a chunk on standard out.
 */
export interface Stdout extends OutputBase {
  stream: 'stdout';
}

/**
 * A script's spawned process emitted a chunk on standard error.
 */
export interface Stderr extends OutputBase {
  stream: 'stderr';
}

// -------------------------------
// Other events
// -------------------------------

/**
 * A script is waiting for its dependencies to complete.
 */
export interface DependenciesPending extends ScriptEventBase {
  type: 'dependencies-pending';
}

/**
 * A script's dependencies have all been resolved.
 */
export interface DependenciesResolved extends ScriptEventBase {
  type: 'dependencies-resolved';
}

/**
 * A script's output could not be found in the cache.
 */
export interface CacheMiss extends ScriptEventBase {
  type: 'cache-miss';
}

/**
 * A script is temporarily being prevented from spawning its command (for at
 * least one macrotask) because there are already too many processes spawned.
 */
export interface ParallelContention extends ScriptEventBase {
  type: 'parallel-contention';
}

/**
 * A script's previous output was deleted.
 */
export interface OutputDeleted extends ScriptEventBase {
  type: 'output-deleted';
  numDeleted: number;
}

/**
 * A script is delegating incremental build behavior to the process (e.g.
 * because a .tsbuildinfo file was specified in the incrementalBuildOutput
 * list).
 */
export interface IncrementalDelegation extends ScriptEventBase {
  type: 'incremental-delegation';
  /**
   * The file path(s) that triggered this delegation (e.g. the .tsbuildinfo file
   * path).
   */
  files: string[];
}

/**
 * A script spawned a process for its command.
 */
export interface Spawn extends ScriptEventBase {
  type: 'spawn';
  command: string;
}

/**
 * A script's output is being saved to the cache.
 */
export interface CacheSave extends ScriptEventBase {
  type: 'cache-save';
}

/**
 * A script is going to be sent a signal to kill it (e.g. because another script
 * failed and we are in --fail-fast mode).
 */
export interface Killing extends ScriptEventBase {
  type: 'killing';
  /**
   * The signal we are sending.
   */
  signal: NodeJS.Signals;
}
