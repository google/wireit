/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {hrtime} from 'process';
import {Event} from '../event.js';
import {DefaultLogger} from './default-logger.js';
import {Console} from './logger.js';

// To prevent using the global console accidentally, we shadow it with
// undefined
const console = undefined;
function markAsUsed(_: unknown) {}
markAsUsed(console);

interface Metric {
  name: string;
  matches: (event: Event) => boolean;
  count: number;
}

/**
 * A {@link Logger} that keeps track of metrics.
 */
export class MetricsLogger extends DefaultLogger {
  #startTime: [number, number] = hrtime();
  readonly #metrics: [Metric, Metric, Metric, Metric] = [
    {
      name: 'Success',
      // 'no-command' is technically a success, but we don't want to count it as
      // a success for this metric because nothing was actually run.
      matches: (e: Event) => e.type === 'success' && e.reason !== 'no-command',
      count: 0,
    },
    {
      name: 'Ran',
      matches: (e: Event) => e.type === 'success' && e.reason === 'exit-zero',
      count: 0,
    },
    {
      name: 'Skipped (fresh)',
      matches: (e: Event) => e.type === 'success' && e.reason === 'fresh',
      count: 0,
    },
    {
      name: 'Restored from cache',
      matches: (e: Event) => e.type === 'success' && e.reason === 'cached',
      count: 0,
    },
  ];

  /**
   * @param rootPackage The npm package directory that the root script being
   * executed belongs to.
   */
  constructor(rootPackage: string, console: Console) {
    super(rootPackage, console);
  }

  /**
   * Update relevant metrics for an event and pass it up to the parent logger.
   */
  override log(event: Event): void {
    // When in watch mode, metrics should reset at the start of each run.
    if (event.type === 'info' && event.detail === 'watch-run-start') {
      this.#resetMetrics();
    }

    this.#updateMetrics(event);
    super.log(event);
  }

  /**
   * Log the current metrics and reset the state of each metric.
   */
  override printMetrics(): void {
    const successes = this.#metrics[0].count ?? 0;

    if (!successes) {
      this.#resetMetrics();
      return;
    }

    const elapsed = this.#getElapsedTime();
    const nameOffset = 20;

    const out: string[] = [
      `🏁 [metrics] Executed ${successes} script(s) in ${elapsed} seconds`,
    ];

    for (const metric of this.#metrics.slice(1)) {
      const name = metric.name.padEnd(nameOffset);
      const count = metric.count;
      const percent = this.#calculatePercentage(count, successes);

      out.push(`\t${name}: ${count} (${percent}%)`);
    }

    this.console.log(out.join('\n'));

    this.#resetMetrics();
  }

  #updateMetrics(event: Event): void {
    for (const metric of this.#metrics) {
      if (metric.matches(event)) {
        metric.count++;
      }
    }
  }

  #resetMetrics(): void {
    this.#startTime = hrtime();

    for (const metric of this.#metrics) {
      metric.count = 0;
    }
  }

  #getElapsedTime(): string {
    const [seconds, nanoseconds] = hrtime(this.#startTime);
    const time = seconds + nanoseconds / 1e9;
    return time.toFixed(2);
  }

  #calculatePercentage(numerator: number, denominator: number): number {
    if (denominator === 0) {
      return 0;
    }

    return Math.floor((numerator / denominator) * 100);
  }
}
