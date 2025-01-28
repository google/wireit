/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import {unreachable} from '../util/unreachable.js';

import type {Event} from '../event.js';
import type {Logger, Console} from './logger.js';
import {type PackageReference, type ScriptReference} from '../config.js';
import {DiagnosticPrinter} from '../error.js';
import {createRequire} from 'module';
import {WatchLogger} from './watch-logger.js';

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

// To prevent using the global console accidentally, we shadow it with
// undefined
const console = undefined;
function markAsUsed(_: unknown) {}
markAsUsed(console);

/**
 * Simple {@link Logger} which logs to stdout and stderr.
 */
export class SimpleLogger implements Logger {
  readonly #rootPackageDir: string;
  readonly console: Console;
  readonly #diagnosticPrinter: DiagnosticPrinter;

  /**
   * @param rootPackage The npm package directory that the root script being
   * executed belongs to.
   */
  constructor(rootPackage: string, ourConsole: Console) {
    this.#rootPackageDir = rootPackage;
    this.#diagnosticPrinter = new DiagnosticPrinter(this.#rootPackageDir);
    this.console = ourConsole;
  }

  log(event: Event) {
    const type = event.type;
    const label = labelForScript(this.#rootPackageDir, event.script);
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
              `Unknown success reason: ${unreachable(reason) as string}`,
            );
          }
          case 'exit-zero': {
            this.console.log(`✅${prefix} Executed successfully`);
            break;
          }
          case 'no-command': {
            this.console.log(`✅${prefix} No command to execute`);
            break;
          }
          case 'fresh': {
            this.console.log(`✅${prefix} Already fresh`);
            break;
          }
          case 'cached': {
            this.console.log(`✅${prefix} Restored from cache`);
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
              `Unknown failure reason: ${unreachable(reason) as string}`,
            );
          }
          case 'launched-incorrectly': {
            this.console.error(
              `❌${prefix} wireit must be launched with "npm run" or a compatible command.`,
            );
            this.console.error(`    More info: ${event.detail}`);
            break;
          }
          case 'missing-package-json': {
            this.console.error(
              `❌${prefix} No package.json was found in ${event.script.packageDir}`,
            );
            break;
          }
          case 'invalid-json-syntax': {
            for (const diagnostic of event.diagnostics) {
              this.console.error(this.#diagnosticPrinter.print(diagnostic));
            }
            break;
          }

          case 'no-scripts-in-package-json': {
            this.console.error(
              `❌${prefix} No "scripts" section defined in package.json in ${event.script.packageDir}`,
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
            this.console.error(this.#diagnosticPrinter.print(event.diagnostic));
            break;
          }
          case 'invalid-usage': {
            this.console.error(`❌${prefix} Invalid usage: ${event.message}`);
            break;
          }
          case 'exit-non-zero': {
            this.console.error(
              `❌${prefix} Failed with exit status ${event.status}`,
            );
            break;
          }

          case 'signal': {
            this.console.error(
              `❌${prefix} Failed with signal ${event.signal}`,
            );
            break;
          }
          case 'spawn-error': {
            this.console.error(
              `❌${prefix} Process spawn error: ${event.message}`,
            );
            break;
          }
          case 'start-cancelled': {
            // The script never started. We don't really need to log this, it's
            // fairly noisy. Maybe in a verbose mode.
            break;
          }
          case 'failed-previous-watch-iteration': {
            this.console.error(
              `❌${prefix} Failed on previous watch iteration`,
            );
            break;
          }
          case 'killed': {
            this.console.error(`💀${prefix} Killed`);
            break;
          }
          case 'unknown-error-thrown': {
            this.console.error(
              `❌${prefix} Internal error! Please file a bug at https://github.com/google/wireit/issues/new, mention this message, that you encountered it in wireit version ${getWireitVersion()}, and give information about your package.json files.\n    Unknown error thrown: ${String(
                event.error,
              )}`,
            );
            const maybeError = event.error as Partial<Error> | undefined;
            if (maybeError?.stack) {
              this.console.error(maybeError.stack);
            }
            break;
          }
          case 'dependency-invalid': {
            this.console.error(
              `❌${prefix} Depended, perhaps indirectly, on ${labelForScript(
                this.#rootPackageDir,
                event.dependency,
              )} which could not be validated. Please file a bug at https://github.com/google/wireit/issues/new, mention this message, that you encountered it in wireit version ${getWireitVersion()}, and give information about your package.json files.`,
            );
            break;
          }
          case 'service-exited-unexpectedly': {
            this.console.error(`❌${prefix} Service exited unexpectedly`);
            break;
          }
          case 'input-file-deleted-unexpectedly': {
            for (const filePath of event.filePaths) {
              this.console.error(
                `❌${prefix} Input file "${filePath}" was deleted unexpectedly. Is another process writing to the same location?`,
              );
            }
            break;
          }
          case 'output-file-deleted-unexpectedly': {
            for (const filePath of event.filePaths) {
              this.console.error(
                `❌${prefix} Output file "${filePath}" was deleted unexpectedly. Is another process writing to the same location?`,
              );
            }
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
              `Unknown output stream: ${unreachable(stream) as string}`,
            );
          }
          // TODO(aomarks) More advanced handling of output streams so that
          // output isn't simply interweaved.
          case 'stdout': {
            this.console.stdout.write(event.data);
            break;
          }
          case 'stderr': {
            this.console.stderr.write(event.data);
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
              `Unknown info event detail: ${unreachable(detail) as string}`,
            );
          }
          case 'running': {
            this.console.log(
              `🏃${prefix} Running command "${
                event.script.command?.value ?? ''
              }"`,
            );
            break;
          }
          case 'locked': {
            this.console.log(
              `💤${prefix} Waiting for another process which is already running this script.`,
            );
            break;
          }
          case 'output-modified': {
            this.console.log(
              `ℹ️${prefix} Output files were modified since the previous run.`,
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
              this.console.log('\x1Bc');
            }
            break;
          }
          case 'watch-run-end': {
            this.console.log(`👀${prefix} Watching for file changes`);
            break;
          }
          case 'cache-info': {
            this.console.log(`ℹ️${prefix} ${event.message}`);
            break;
          }
          case 'service-process-started': {
            this.console.log(`⬆️${prefix} Service starting...`);
            break;
          }
          case 'service-ready': {
            this.console.log(`⬆️${prefix} Service ready`);
            break;
          }
          case 'service-stopped': {
            this.console.log(`⬇️${prefix} Service stopped`);
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

  getWatchLogger(): Logger {
    return new WatchLogger(this);
  }

  [Symbol.dispose](): void {
    this.console[Symbol.dispose]();
  }
}

/**
 * Make a concise label for a script, or for just a package if we don't know
 * the script name. If the package is different to the root package, it is
 * disambiguated with a relative path.
 */
export function labelForScript(
  rootPackageDir: string,
  script: ScriptReference | PackageReference,
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
