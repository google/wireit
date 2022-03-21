/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {unreachable} from '../util/unreachable.js';

import type {Event} from '../event.js';
import type {Logger} from './logger.js';

/**
 * Default {@link Logger} which logs to stdout and stderr.
 */
export class DefaultLogger implements Logger {
  log(event: Event) {
    const type = event.type;
    // TODO(aomarks) Also include a relative package path in the log prefix when
    // cross-package dependencies are supported.
    const prefix = 'name' in event.script ? ` [${event.script.name}]` : '';
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
          case 'exit-non-zero': {
            console.error(
              `❌${prefix} Failed with exit status ${event.status}`
            );
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
              process.stderr.write(event.trail[i].name);
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
