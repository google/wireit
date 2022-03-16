/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import type {
  Script,
  PackageReference,
  ScriptReferenceWithParents,
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

type Success = ExitZero;

interface SuccessBase<T extends PackageReference> extends EventBase<T> {
  type: 'success';
}

/**
 * A script finished with exit code 0.
 */
export interface ExitZero extends SuccessBase<Script> {
  reason: 'exit-zero';
}

// -------------------------------
// Failure events
// -------------------------------

export type Failure = ExitNonZero | ScriptNotFound;

interface ErrorBase<T extends PackageReference> extends EventBase<T> {
  type: 'failure';
}

/**
 * A script finished with an exit status that was not 0.
 */
export interface ExitNonZero extends ErrorBase<Script> {
  reason: 'exit-non-zero';
  status: number;
}

/**
 * The specified script does not exist in a package.json.
 */
export interface ScriptNotFound extends ErrorBase<ScriptReferenceWithParents> {
  reason: 'script-not-found';
}

// -------------------------------
// Output events
// -------------------------------

type Output = Stdout | Stderr;

interface OutputBase extends EventBase<Script> {
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

interface InfoBase extends EventBase<Script> {
  type: 'info';
}

/**
 * A script's command started running.
 */
export interface ScriptRunning extends InfoBase {
  detail: 'running';
}
