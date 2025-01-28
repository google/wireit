/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {SimpleLogger} from './simple-logger.js';
import {Event} from '../event.js';
import {inspect} from 'node:util';

// To prevent using the global console accidentally, we shadow it with
// undefined
const console = undefined;
function markAsUsed(_: unknown) {}
markAsUsed(console);

/**
 * A {@link Logger} for logging debug information, mainly in tests.
 */
export class DebugLogger extends SimpleLogger {
  override log(event: Event) {
    switch (event.type) {
      case 'info':
        this.console.log(`<info> ${event.detail}`);
        break;
      case 'failure':
        this.console.log(`<failure> ${event.reason}`);
        break;
      case 'output':
        // too verbose, log nothing
        return;
      case 'success':
        this.console.log(`<success> ${event.reason}`);
        break;
      default: {
        const never: never = event;
        throw new Error(`Unknown event type: ${inspect(never)}`);
      }
    }
    super.log(event);
  }

  [Symbol.dispose](): void {
    super[Symbol.dispose]();
    this.console[Symbol.dispose]();
  }
}
