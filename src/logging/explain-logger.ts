/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {inspect} from 'node:util';
import {
  FingerprintDifference,
  Event,
  ExecutionRequestedReason,
  NotFreshReason,
  NotFullyTrackedReason,
  OutputManifestOutdatedReason,
  ScriptRunning,
} from '../event.js';
import {DefaultLogger, labelForScript} from './default-logger.js';
import {Logger} from './logger.js';
import {stringToScriptReference} from '../config.js';
import * as pathlib from 'node:path';

export class ExplainLogger extends DefaultLogger {
  override log(event: Event): void {
    if (event.type === 'output') {
      // When explaining, we care about what wireit is doing, not what
      // the scripts are doing, so don't log output.
      return;
    }
    super.log(event);
    if (event.type === 'info' && event.detail === 'running') {
      this.#logRunning(event);
    }
  }
  #logRunning(event: ScriptRunning) {
    const notFreshExplanation = this.#explainNotFreshReason(
      event.notFreshReason,
    );
    const executionExplanation = this.#explainExecutionRequestedReason(
      event.executionRequestedReason,
    );
    this.console.log(`├  You asked it to run because ${executionExplanation}.`);
    this.console.log(`└  It can't be skipped because ${notFreshExplanation}.`);
  }

  #explainExecutionRequestedReason(reason: ExecutionRequestedReason): string {
    if (reason.path.length === 0) {
      return 'it was the root script you asked for';
    }
    if (reason.path.length === 1) {
      return `it was a direct dependency of the root script [${labelForScript(
        this.rootPackageDir,
        stringToScriptReference(reason.path[0]!),
      )}] you asked for`;
    }
    const path = reason.path
      .map(
        (p) =>
          `[${labelForScript(
            this.rootPackageDir,
            stringToScriptReference(p),
          )}]`,
      )
      .join(' -> ');
    return `it was a dependency along this path: ${path}`;
  }

  #explainNotFreshReason(reason: NotFreshReason): string {
    switch (reason.name) {
      default: {
        const never: never = reason;
        throw new Error(`Unknown not-fresh reason: ${inspect(never)}`);
      }
      case 'no-previous-fingerprint': {
        return `this looks like the first run (no previous fingerprint found)`;
      }
      case 'fingerprints-differed': {
        return this.#explainFingerprintsDifferedReason(reason.difference);
      }
      case 'not-fully-tracked': {
        return this.#explainNotFullyTrackedReason(reason.reason);
      }
      case 'output manifest outdated': {
        return this.#explainOutputManifestOutdatedReason(reason.reason);
      }
    }
  }

  #explainFingerprintsDifferedReason(
    difference: FingerprintDifference,
  ): string {
    switch (difference.name) {
      default: {
        const never: never = difference;
        throw new Error(`Unknown not-fully-tracked reason: ${inspect(never)}`);
      }
      case 'config': {
        return `its ${
          difference.field
        } field in the package.json file changed from ${inspect(
          difference.current,
        )} to ${inspect(difference.previous)}`;
      }
      case 'environment': {
        return `the ${
          difference.field
        } aspect of the runtime environment changed from ${inspect(
          difference.current,
        )} to ${inspect(difference.previous)}`;
      }
      case 'file added': {
        return `its input file ${pathlib.relative(
          this.rootPackageDir,
          difference.path,
        )} was created`;
      }
      case 'file removed': {
        return `its input file ${pathlib.relative(
          this.rootPackageDir,
          difference.path,
        )} was deleted`;
      }
      case 'file changed': {
        return `its input file ${pathlib.relative(
          this.rootPackageDir,
          difference.path,
        )} was modified`;
      }
      case 'dependency added': {
        return `its dependency on [${labelForScript(
          this.rootPackageDir,
          stringToScriptReference(difference.script),
        )}] was added`;
      }
      case 'dependency removed': {
        return `its dependency on [${labelForScript(
          this.rootPackageDir,
          stringToScriptReference(difference.script),
        )}] was removed`;
      }
      case 'dependency changed': {
        return `its dependency [${labelForScript(
          this.rootPackageDir,
          stringToScriptReference(difference.script),
        )}] was re-run, so we needed to as well`;
      }
    }
  }

  #explainOutputManifestOutdatedReason(
    reason: OutputManifestOutdatedReason,
  ): string {
    switch (reason) {
      default: {
        const never: never = reason;
        throw new Error(
          `Unknown output manifest outdated reason: ${inspect(never)}`,
        );
      }
      case `can't glob output files`: {
        return `unable to glob output files`;
      }
      case 'no previous manifest': {
        return `this looks like the first run (no previous output manifest found)`;
      }
      case 'output modified': {
        return `output files were modified since the previous run`;
      }
    }
  }

  #explainNotFullyTrackedReason(reason: NotFullyTrackedReason): string {
    switch (reason.name) {
      default: {
        const never: never = reason;
        throw new Error(`Unknown not-fully-tracked reason: ${inspect(never)}`);
      }
      case 'dependency not fully tracked': {
        return `depends on ${labelForScript(
          this.rootPackageDir,
          stringToScriptReference(reason.dependency),
        )} which must always be run`;
      }
      case 'no files field': {
        return `it has no "files" field and so it must always be run`;
      }
      case 'no output field': {
        return `it has no "output" field and so it must always be run`;
      }
    }
  }

  override printMetrics(): void {
    return;
  }

  override getWatchLogger(): Logger {
    // Don't use watchLogger, we don't want to clear the terminal.
    return this;
  }
}
