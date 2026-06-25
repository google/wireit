/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import chokidar, {
  type ChokidarOptions,
  type FSWatcher as ChokidarFSWatcher,
} from 'chokidar';
import picomatch from 'picomatch';
import globParent from 'glob-parent';
import * as pathlib from 'path';

/** Debug logging for diagnosing Windows CI watcher issues */
function watchDebug(msg: string, extra?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const hrTime = performance.now().toFixed(1);
  const extraStr = extra ? ' ' + JSON.stringify(extra) : '';
  console.error(`[CHOKIDAR-DEBUG ${ts} +${hrTime}ms] ${msg}${extraStr}`);
}

/**
 * Normalize a path to use forward slashes. Chokidar 4 normalizes all paths
 * to forward slashes internally, so we must do the same when comparing paths
 * in our `ignored` callback and emit filter.
 */
function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Invoke Chokidar with additional support for glob patterns, emulating the
 * behavior of chokidar 3.
 *
 * Chokidar 4 removed support for glob patterns. The original chokidar 3
 * implementation with glob support can be found at
 * https://github.com/paulmillr/chokidar/blob/3.6.0/index.js.
 *
 * To support watching a glob pattern, we (1) extract the static directory
 * portion of the glob and watch it recursively, and (2) filter down matching
 * events to only those paths that matched the original glob pattern (because
 * the directory watch is too coarse-grained).
 *
 * For example, given "a/b/*.js", we watch the folder "a/b" recursively, and
 * then filter events so that "a/b/foo.js" matches but "a/b/foo.d.ts" does not.
 */
export function chokidarWatchWithGlobs(
  patterns: string[],
  // The `ignored` option is not supported here from callers because we override
  // it internally for glob filtering and do not bother supporting also calling
  // (polymorphic) caller-supplied one.
  options?: Omit<ChokidarOptions, 'ignored'> & {ignored?: never},
): ChokidarFSWatcher {
  const resolvedCwd = pathlib.resolve(options?.cwd ?? '.');
  watchDebug('chokidarWatchWithGlobs called', {
    patterns,
    cwd: resolvedCwd,
    usePolling: options?.usePolling,
    ignoreInitial: options?.ignoreInitial,
    interval: options?.interval,
  });
  const staticWatchPaths = new Set<string>();
  const rules: {
    ignore: boolean;
    test: (path: string) => boolean;
  }[] = [];

  for (const pattern of patterns) {
    const isNegated = pattern.startsWith('!');
    const raw = isNegated ? pattern.slice(1) : pattern;
    const absolute = pathlib.resolve(resolvedCwd, raw);
    // Normalize to forward slashes for comparison with chokidar's paths.
    // Chokidar 4 normalizes all paths to forward slashes internally.
    const absoluteFwd = toForwardSlashes(absolute);
    const isGlob = picomatch.scan(absolute).isGlob;

    if (isNegated) {
      rules.push({
        ignore: true,
        test: isGlob
          ? picomatch(absolute, {dot: true})
          : (p) => {
              const pFwd = toForwardSlashes(p);
              return pFwd === absoluteFwd || pFwd.startsWith(absoluteFwd + '/');
            },
      });
    } else if (isGlob) {
      staticWatchPaths.add(globParent(absolute));
      rules.push({ignore: false, test: picomatch(absolute, {dot: true})});
    } else {
      staticWatchPaths.add(absolute);
      rules.push({
        ignore: false,
        test: (p) => {
          const pFwd = toForwardSlashes(p);
          return pFwd === absoluteFwd || pFwd.startsWith(absoluteFwd + '/');
        },
      });
    }
  }

  watchDebug('chokidarWatchWithGlobs: setting up watcher', {
    staticWatchPaths: [...staticWatchPaths],
    ruleCount: rules.length,
  });

  const watcher = chokidar.watch(
    staticWatchPaths.size > 0 ? [...staticWatchPaths] : [resolvedCwd],
    {
      ...options,
      ignored: (path: string, stats) => {
        // Chokidar calls `ignored` twice per path: first without stats
        // (to decide whether to even stat the path), then with stats. We
        // must return false here so chokidar proceeds to stat the path,
        // since we need stats to distinguish files from directories.
        if (!stats) {
          watchDebug('ignored callback (no stats, returning false)', {path});
          return false;
        }
        // Never ignore directories, or chokidar won't recurse into them.
        if (stats.isDirectory()) {
          watchDebug('ignored callback (directory, returning false)', {path});
          return false;
        }
        // Take the last matching rule because later rules shadow earlier ones
        // (e.g. `foo/*.js` followed by `!foo/*.js`).
        const lastMatchingRule = rules.findLast((r) => r.test(path));
        if (lastMatchingRule) {
          watchDebug('ignored callback (rule matched)', {path, ignore: lastMatchingRule.ignore});
          return lastMatchingRule.ignore;
        }
        // No rule matched — this file is in a watched directory but doesn't
        // match any pattern, so ignore it.
        watchDebug('ignored callback (no rule matched, ignoring)', {path});
        return true;
      },
    },
  );

  // Log chokidar lifecycle events
  watcher.on('ready', () => {
    const watched = watcher.getWatched();
    const watchedKeys = Object.keys(watched);
    const watchedDetails: Record<string, string[]> = {};
    for (const k of watchedKeys) {
      watchedDetails[k] = watched[k] as string[];
    }
    watchDebug('chokidar READY event fired', {
      cwd: resolvedCwd,
      watchedDirCount: watchedKeys.length,
      watchedDetails,
    });
    // Also log after a short delay to see if watcher state stabilizes
    setTimeout(() => {
      const watched2 = watcher.getWatched();
      const keys2 = Object.keys(watched2);
      const details2: Record<string, string[]> = {};
      for (const k of keys2) {
        details2[k] = watched2[k] as string[];
      }
      watchDebug('chokidar DELAYED getWatched (500ms after ready)', {
        cwd: resolvedCwd,
        watchedDirCount: keys2.length,
        watchedDetails: details2,
      });
    }, 500);
  });
  watcher.on('error', (err: unknown) => {
    watchDebug('chokidar ERROR event', {error: String(err)});
  });
  // Log the raw events from chokidar BEFORE our emit filter
  watcher.on('raw', (event: string, path: string, details: unknown) => {
    watchDebug('chokidar RAW event', {event, path, details: String(details)});
  });

  // Chokidar 4 only checks `ignored` during the initial directory scan, not
  // on subsequent change events. Override `emit` to also filter those.
  const originalEmit = watcher.emit;
  watcher.emit = ((event: string, ...args: unknown[]): boolean => {
    // For individual events like 'add' or 'change', the path is args[0].
    // For the 'all' meta-event, the path is args[1] (args[0] is the event name).
    const filePath =
      event === 'all' ? args[1] :
      event === 'add' || event === 'change' || event === 'unlink' ||
      event === 'addDir' || event === 'unlinkDir' ? args[0] :
      undefined;
    if (typeof filePath === 'string') {
      // Normalize to forward slashes, matching chokidar's convention.
      const absolutePath = toForwardSlashes(pathlib.resolve(resolvedCwd, filePath));
      const lastMatchingRule = rules.findLast((r) => r.test(absolutePath));
      if (!lastMatchingRule || lastMatchingRule.ignore) {
        watchDebug('emit FILTERED OUT', {event, filePath, absolutePath, matched: !!lastMatchingRule, ignored: lastMatchingRule?.ignore});
        return false;
      }
      watchDebug('emit PASSED', {event, filePath, absolutePath});
    } else if (event !== 'ready' && event !== 'error' && event !== 'raw') {
      watchDebug('emit (no path filtering)', {event, args: args.map(String)});
    }
    return originalEmit.apply(watcher, [event, ...args] as Parameters<
      typeof originalEmit
    >);
  }) as typeof watcher.emit;

  return watcher;
}
