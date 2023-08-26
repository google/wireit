/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import {unreachable} from '../util/unreachable.js';

import type {Event} from '../event.js';
import type {Logger} from './logger.js';
import type {PackageReference, ScriptReference} from '../config.js';
import {DiagnosticPrinter} from '../error.js';
import {createRequire} from 'module';

const getWireitVersion = (() => {
  let version: string | undefined;
  return () => {
    if (version === undefined) {
      version = (
        createRequire(import.meta.url)('../../package.json') as {
          version: string;
        }
      ).version;
    }
    return version;
  };
})();

/**
 * Default {@link Logger} which logs to stdout and stderr.
 */
export class DefaultLogger implements Logger {
  private readonly _rootPackageDir: string;
  private readonly _diagnosticPrinter: DiagnosticPrinter;

  /**
   * @param rootPackage The npm package directory that the root script being
   * executed belongs to.
   */
  constructor(rootPackage: string) {
    this._rootPackageDir = rootPackage;
    this._diagnosticPrinter = new DiagnosticPrinter(this._rootPackageDir);
  }

  log(event: Event) {
    const type = event.type;
    const label = labelForScript(this._rootPackageDir, event.script);
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
        if (event.logged) {
          return;
        }
        event.logged = true;
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
              console.error(this._diagnosticPrinter.print(diagnostic));
            }
            break;
          }

          case 'no-scripts-in-package-json': {
            console.error(
              `❌${prefix} No "scripts" section defined in package.json in ${event.script.packageDir}`
            );
            break;
          }
          case 'script-not-found':
          case 'wireit-config-but-no-script':
          case 'duplicate-dependency':
          case 'script-not-wireit':
          case 'invalid-config-syntax':
          case 'cycle':
          case 'dependency-on-missing-package-json':
          case 'dependency-on-missing-script': {
            console.error(this._diagnosticPrinter.print(event.diagnostic));
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
          case 'start-cancelled': {
            // The script never started. We don't really need to log this, it's
            // fairly noisy. Maybe in a verbose mode.
            break;
          }
          case 'failed-previous-watch-iteration': {
            console.error(`❌${prefix} Failed on previous watch iteration`);
            break;
          }
          case 'killed': {
            console.error(`💀${prefix} Killed`);
            break;
          }
          case 'unknown-error-thrown': {
            console.error(
              `❌${prefix} Internal error! Please file a bug at https://github.com/google/wireit/issues/new, mention this message, that you encountered it in wireit version ${getWireitVersion()}, and give information about your package.json files.\n    Unknown error thrown: ${String(
                event.error
              )}`
            );
            const maybeError = event.error as Partial<Error> | undefined;
            if (maybeError?.stack) {
              console.error(maybeError.stack);
            }
            break;
          }
          case 'dependency-invalid': {
            console.error(
              `❌${prefix} Depended, perhaps indirectly, on ${labelForScript(
                this._rootPackageDir,
                event.dependency
              )} which could not be validated. Please file a bug at https://github.com/google/wireit/issues/new, mention this message, that you encountered it in wireit version ${getWireitVersion()}, and give information about your package.json files.`
            );
            break;
          }
          case 'service-exited-unexpectedly': {
            console.error(`❌${prefix} Service exited unexpectedly`);
            break;
          }
          case 'aborted':
          case 'dependency-service-exited-unexpectedly': {
            // These event isn't very useful to log, because they are downstream
            // of failures that already get reported elsewhere.
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
          case 'locked': {
            console.log(
              `💤${prefix} Waiting for another process which is already running this script.`
            );
            break;
          }
          case 'output-modified': {
            console.log(
              `ℹ️${prefix} Output files were modified since the previous run.`
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
          case 'service-started': {
            console.log(`⬆️${prefix} Service started`);
            break;
          }
          case 'service-stopped': {
            console.log(`⬇️${prefix} Service stopped`);
            break;
          }
          case 'analysis-started':
          case 'analysis-completed': {
            break;
          }
        }
      }
    }
  }

  printMetrics(): void {
    // printMetrics() not used in default-logger.
  }
}

/**
 * Make a concise label for a script, or for just a package if we don't know
 * the script name. If the package is different to the root package, it is
 * disambiguated with a relative path.
 */
export function labelForScript(
  rootPackageDir: string,
  script: ScriptReference | PackageReference
) {
  const packageDir = script.packageDir;
  const scriptName = 'name' in script ? script.name : undefined;
  if (packageDir !== rootPackageDir) {
    const relativePackageDir = pathlib
      .relative(rootPackageDir, script.packageDir)
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
