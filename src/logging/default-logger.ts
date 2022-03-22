/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import * as pathlib from 'path';
import {unreachable} from '../util/unreachable.js';

import type {Event} from '../event.js';
import type {Logger} from './logger.js';
import type {PackageReference, ScriptReference} from '../script.js';

/**
 * Default {@link Logger} which logs to stdout and stderr.
 */
export class DefaultLogger implements Logger {
  private readonly _rootPackageDir: string;

  /**
   * @param rootPackage The npm package directory that the root script being
   * executed belongs to.
   */
  constructor(rootPackage: string) {
    this._rootPackageDir = rootPackage;
  }

  /**
   * Make a concise label for a script, or for just a package if we don't know
   * the script name. If the package is different to the root package, it is
   * disambiguated with a relative path.
   */
  private _label(script: PackageReference | ScriptReference) {
    const packageDir = script.packageDir;
    const scriptName = 'name' in script ? script.name : undefined;
    if (packageDir !== this._rootPackageDir) {
      const relativePackageDir = pathlib
        .relative(this._rootPackageDir, script.packageDir)
        // Normalize to posix-style forward-slashes as the path separator, even
        // on Windows which usually uses back-slashes. This way labels match the
        // syntax used in the package.json dependency specifiers (which are
        // already posix style).
        .replace(pathlib.sep, pathlib.posix.sep);
      if (scriptName !== undefined) {
        return `${relativePackageDir}:${scriptName}`;
      } else {
        return relativePackageDir;
      }
    } else if (scriptName !== undefined) {
      return scriptName;
    }
    return '';
  }

  log(event: Event) {
    const type = event.type;
    const label = this._label(event.script);
    const prefix = label !== '' ? ` [${label}]` : '';
    switch (type) {
      default: {
        throw new Error(`Unknown event type: ${unreachable(type) as string}`);
      }

      case 'success': {
        const reason = event.reason;
        switch (reason) {
          default: {
            throw new Error(
              `Unknown success reason: ${unreachable(reason) as string}`
            );
          }
          case 'exit-zero': {
            console.log(`✅${prefix} Executed successfully`);
            break;
          }
          case 'no-command': {
            console.log(`✅${prefix} No command to execute`);
            break;
          }
        }
        break;
      }

      case 'failure': {
        const reason = event.reason;
        switch (reason) {
          default: {
            throw new Error(
              `Unknown failure reason: ${unreachable(reason) as string}`
            );
          }
          case 'launched-incorrectly': {
            console.error(`❌${prefix} wireit must be launched with "npm run"`);
            break;
          }
          case 'missing-package-json': {
            console.error(
              `❌${prefix} No package.json was found in ${event.script.packageDir}`
            );
            break;
          }
          case 'invalid-package-json': {
            console.error(
              `❌${prefix} Invalid JSON in package.json file in ${event.script.packageDir}`
            );
            break;
          }
          case 'script-not-found': {
            console.error(
              `❌${prefix} No script named "${event.script.name}" was found in ${event.script.packageDir}`
            );
            break;
          }
          case 'script-not-wireit': {
            console.error(
              `❌${prefix} Script is not configured to call "wireit"`
            );
            break;
          }
          case 'invalid-config-syntax': {
            console.error(`❌${prefix} Invalid config: ${event.message}`);
            break;
          }
          case 'exit-non-zero': {
            console.error(
              `❌${prefix} Failed with exit status ${event.status}`
            );
            break;
          }
          case 'duplicate-dependency': {
            console.error(
              `❌${prefix} The dependency "${event.dependency.name}" was declared multiple times`
            );
            break;
          }
          case 'signal': {
            console.error(`❌${prefix} Failed with signal ${event.signal}`);
            break;
          }
          case 'spawn-error': {
            console.error(`❌${prefix} Process spawn error: ${event.message}`);
            break;
          }
          case 'cycle': {
            console.error(`❌${prefix} Cycle detected`);
            // Display the trail of scripts and indicate where the loop is, like
            // this:
            //
            //     a
            // .-> b
            // |   c
            // `-- b
            const cycleEnd = event.trail.length - 1;
            const cycleStart = cycleEnd - event.length;
            for (let i = 0; i < event.trail.length; i++) {
              if (i < cycleStart) {
                process.stderr.write('    ');
              } else if (i === cycleStart) {
                process.stderr.write(`.-> `);
              } else if (i !== cycleEnd) {
                process.stderr.write('|   ');
              } else {
                process.stderr.write('`-- ');
              }
              process.stderr.write(this._label(event.trail[i]));
              process.stderr.write('\n');
            }
            break;
          }
        }
        break;
      }

      case 'output': {
        const stream = event.stream;
        switch (stream) {
          default: {
            throw new Error(
              `Unknown output stream: ${unreachable(stream) as string}`
            );
          }
          // TODO(aomarks) More advanced handling of output streams so that
          // output isn't simply interweaved.
          case 'stdout': {
            process.stdout.write(event.data);
            break;
          }
          case 'stderr': {
            process.stderr.write(event.data);
            break;
          }
        }
        break;
      }

      case 'info': {
        const detail = event.detail;
        switch (detail) {
          default: {
            throw new Error(
              `Unknown info event detail: ${unreachable(detail) as string}`
            );
          }
          case 'running': {
            console.log(
              `🏃${prefix} Running command "${event.script.command ?? ''}"`
            );
            break;
          }
        }
      }
    }
  }
}
