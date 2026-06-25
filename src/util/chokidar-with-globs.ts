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

// Picomatch treats backslashes as escape characters, not path separators.
// Normalize all paths to forward slashes before passing to picomatch.
const toForwardSlash = (p: string) => p.replaceAll('\\', '/');

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
  const staticWatchPaths = new Set<string>();
  const rules: {
    ignore: boolean;
    test: (path: string) => boolean;
  }[] = [];

  for (const pattern of patterns) {
    const isNegated = pattern.startsWith('!');
    const raw = isNegated ? pattern.slice(1) : pattern;
    const absolute = toForwardSlash(
      pathlib.resolve(pathlib.join(resolvedCwd, raw)),
    );
    const isGlob = picomatch.scan(absolute).isGlob;

    if (isNegated) {
      rules.push({
        ignore: true,
        test: isGlob
          ? picomatch(absolute, {dot: true})
          : (p) =>
              toForwardSlash(p) === absolute ||
              toForwardSlash(p).startsWith(absolute + '/'),
      });
    } else if (isGlob) {
      staticWatchPaths.add(globParent(absolute));
      rules.push({ignore: false, test: picomatch(absolute, {dot: true})});
    } else {
      staticWatchPaths.add(absolute);
      rules.push({
        ignore: false,
        test: (p) =>
          toForwardSlash(p) === absolute ||
          toForwardSlash(p).startsWith(absolute + '/'),
      });
    }
  }

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
          return false;
        }
        // Never ignore directories, or chokidar won't recurse into them.
        if (stats.isDirectory()) {
          return false;
        }
        // Take the last matching rule because later rules shadow earlier ones
        // (e.g. `foo/*.js` followed by `!foo/*.js`).
        const lastMatchingRule = rules.findLast((r) =>
          r.test(toForwardSlash(path)),
        );
        if (lastMatchingRule) {
          return lastMatchingRule.ignore;
        }
        // No rule matched — this file is in a watched directory but doesn't
        // match any pattern, so ignore it.
        return true;
      },
    },
  );

  // The `ignored` callback above must return false for all directories, or
  // chokidar won't recurse into them to find matching files. But this means
  // directory events for unrelated paths (e.g. .wireit/ lock files) pass
  // through unfiltered, causing spurious re-runs. Filter emitted events
  // through our glob rules to suppress them.
  const originalEmit = watcher.emit;
  watcher.emit = ((event: string, ...args: unknown[]): boolean => {
    // For individual events the path is args[0].
    // For the 'all' meta-event the path is args[1] (args[0] is the event name).
    const filePath =
      event === 'all' ? args[1] :
      event === 'add' || event === 'change' || event === 'unlink' ||
      event === 'addDir' || event === 'unlinkDir' ? args[0] :
      undefined;
    if (typeof filePath === 'string') {
      const absolutePath = toForwardSlash(
        pathlib.resolve(resolvedCwd, filePath),
      );
      const lastMatchingRule = rules.findLast((r) => r.test(absolutePath));
      if (!lastMatchingRule || lastMatchingRule.ignore) {
        return false;
      }
    }
    return originalEmit.apply(watcher, [event, ...args] as Parameters<
      typeof originalEmit
    >);
  }) as typeof watcher.emit;

  return watcher;
}
