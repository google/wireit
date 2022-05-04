/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import {unreachable} from '../util/unreachable.js';

import type {Event} from '../event.js';
import type {Logger} from './logger.js';
import type {PackageReference, ScriptReference} from '../script.js';
import {DiagnosticPrinter} from '../error.js';

/**
 * Default {@link Logger} which logs to stdout and stderr.
 */
export class DefaultLogger implements Logger {
  readonly #rootPackageDir: string;
  readonly #diagnosticPrinter: DiagnosticPrinter;

  /**
   * @param rootPackage The npm package directory that the root script being
   * executed belongs to.
   */
  constructor(rootPackage: string) {
    this.#rootPackageDir = rootPackage;
    this.#diagnosticPrinter = new DiagnosticPrinter(this.#rootPackageDir);
  }

  /**
   * Make a concise label for a script, or for just a package if we don't know
   * the script name. If the package is different to the root package, it is
   * disambiguated with a relative path.
   */
  #label(script: PackageReference | ScriptReference) {
    const packageDir = script.packageDir;
    const scriptName = 'name' in script ? script.name : undefined;
    if (packageDir !== this.#rootPackageDir) {
      const relativePackageDir = pathlib
        .relative(this.#rootPackageDir, script.packageDir)
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
    const label = this.#label(event.script);
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
          case 'fresh': {
            console.log(`✅${prefix} Already fresh`);
            break;
          }
          case 'cached': {
            console.log(`✅${prefix} Restored from cache`);
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
            console.error(
              `❌${prefix} wireit must be launched with "npm run" or a compatible command.`
            );
            console.error(`    More info: ${event.detail}`);
            break;
          }
          case 'missing-package-json': {
            console.error(
              `❌${prefix} No package.json was found in ${event.script.packageDir}`
            );
            break;
          }
          case 'invalid-json-syntax': {
            for (const diagnostic of event.diagnostics) {
              console.error(this.#diagnosticPrinter.print(diagnostic));
            }
            break;
          }
          case 'invalid-package-json': {
            console.error(
              `❌${prefix} Invalid JSON in package.json file in ${event.script.packageDir}`
            );
            break;
          }

          case 'no-scripts-in-package-json': {
            console.error(
              `❌${prefix} No "scripts" section defined in package.json in ${event.script.packageDir}`
            );
            break;
          }
          case 'script-not-found':
          case 'duplicate-dependency':
          case 'script-not-wireit':
          case 'invalid-config-syntax':
          case 'cycle': {
            console.error(this.#diagnosticPrinter.print(event.diagnostic));
            break;
          }
          case 'invalid-usage': {
            console.error(`❌${prefix} Invalid usage: ${event.message}`);
            break;
          }
          case 'exit-non-zero': {
            console.error(
              `❌${prefix} Failed with exit status ${event.status}`
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
              `🏃${prefix} Running command "${
                event.script.command?.value ?? ''
              }"`
            );
            break;
          }
          case 'watch-run-start': {
            if (process.stdout.isTTY) {
              // If we are in an interactive terminal (TTY), reset it before
              // each run. This is helpful because it means only the output for
              // the current build is visible. This is exactly the same as what
              // "tsc --watch" does.
              //
              // This string is the ESC character (ASCII \x1B) followed by "c",
              // which is the VT100 reset sequence, supported by most terminals:
              // https://www2.ccs.neu.edu/research/gpc/VonaUtils/vona/terminal/vtansi.htm#:~:text=Reset%20Device
              console.log('\x1Bc');
            }
            break;
          }
          case 'watch-run-end': {
            console.log(`👀${prefix} Watching for file changes`);
            break;
          }
          case 'generic': {
            console.log(`ℹ️${prefix} ${event.message}`);
            break;
          }
        }
      }
    }
  }
}
