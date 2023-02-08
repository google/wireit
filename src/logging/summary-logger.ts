import {hrtime} from 'process';
import {Event} from '../event.js';
import {Logger} from './logger.js';

export class SummaryLogger implements Logger {
  private _actualLogger: Logger;
  private _totalScripts = 0;
  private _startTime: [number, number] = hrtime();
  private _eventCounts: Map<string, number> = new Map<string, number>([
    ['exit-zero', 0],
    ['fresh', 0],
    ['cached', 0],
  ]);

  constructor(actualLogger: Logger) {
    this._actualLogger = actualLogger;
  }

  /**
   * Observes an event, updating the relevant metric if it is interesting, and
   * then passes it along to the standard logger.
   */
  log(event: Event): void {
    this._takeNoteOf(event);
    this._actualLogger.log(event);
  }

  /**
   * Displays a summary of the script execution results to the console.
   */
  printSummary(): void {
    const runTime = this._getElapsedTime();

    const ran = this._eventCounts.get('exit-zero') || 0;
    const percentRan = this._calculatePercentage(ran, this._totalScripts);

    const fresh = this._eventCounts.get('fresh') || 0;
    const percentFresh = this._calculatePercentage(fresh, this._totalScripts);

    const cached = this._eventCounts.get('cached') || 0;
    const percentCached = this._calculatePercentage(cached, this._totalScripts);

    console.log(`🏁 [summary] Executed ${this._totalScripts} script(s) in ${runTime} seconds
    Ran:              ${ran} (${percentRan}%)
    Skipped (fresh):  ${fresh} (${percentFresh}%)
    Skipped (cached): ${cached} (${percentCached}%)`);

    this._reset();
  }

  /**
   * Resets the values of the metrics to their base state.
   */
  private _reset(): void {
    this._totalScripts = 0;
    this._startTime = hrtime();

    for (const event of this._eventCounts.keys()) {
      this._eventCounts.set(event, 0);
    }
  }

  /**
   * Takes note of the event passed in as argument, if it is something that is
   * being tracked.
   */
  private _takeNoteOf(event: Event) {
    if (event.type !== 'success') {
      return;
    }

    if (!this._eventCounts.has(event.reason)) {
      return;
    }

    const count = this._eventCounts.get(event.reason);

    if (count !== undefined) {
      this._eventCounts.set(event.reason, count + 1);
      this._totalScripts++;
    }
  }

  /**
   * Calculates the elapsed time in seconds since the start of this run.
   */
  private _getElapsedTime(): string {
    const elapsed = hrtime(this._startTime);
    const elapsedSeconds = elapsed[0] + elapsed[1] / 1e9;
    return elapsedSeconds.toFixed(2);
  }

  /**
   * Calculates the percentage of part with respect to whole.
   */
  private _calculatePercentage(numerator: number, denominator: number): number {
    if (denominator === 0) {
      return 0;
    }

    return Math.floor((numerator / denominator) * 100);
  }
}
