#!/usr/bin/env node
/**
 * Patches chokidar 4 node_modules to add deep diagnostic logging.
 * Run this AFTER npm ci, BEFORE tests.
 *
 * This patches:
 * 1. handler.js: createFsWatchInstance, _watchWithNodeFs, _handleFile, _addToNodeFs
 * 2. index.js: add(), _isIgnored(), normalizePath internals
 */

const fs = require('fs');
const path = require('path');

const CHOKIDAR_DIR = path.join(__dirname, '..', 'node_modules', 'chokidar');

function patchFile(filename, patches) {
  const filepath = path.join(CHOKIDAR_DIR, filename);
  let content = fs.readFileSync(filepath, 'utf8');

  for (const {find, replace, description} of patches) {
    if (typeof find === 'string') {
      if (!content.includes(find)) {
        console.error(`WARNING: Could not find patch target in ${filename}: ${description}`);
        console.error(`  Looking for: ${find.substring(0, 80)}...`);
        continue;
      }
      content = content.replace(find, replace);
    } else {
      // RegExp
      if (!find.test(content)) {
        console.error(`WARNING: Could not find patch target in ${filename}: ${description}`);
        continue;
      }
      content = content.replace(find, replace);
    }
    console.log(`  ✓ ${filename}: ${description}`);
  }

  fs.writeFileSync(filepath, content, 'utf8');
}

console.log('[PATCH-CHOKIDAR] Patching chokidar for deep diagnostics...');
console.log(`[PATCH-CHOKIDAR] Chokidar dir: ${CHOKIDAR_DIR}`);

// Verify chokidar exists
if (!fs.existsSync(CHOKIDAR_DIR)) {
  console.error('[PATCH-CHOKIDAR] ERROR: chokidar not found at', CHOKIDAR_DIR);
  process.exit(1);
}

const version = JSON.parse(
  fs.readFileSync(path.join(CHOKIDAR_DIR, 'package.json'), 'utf8')
).version;
console.log(`[PATCH-CHOKIDAR] Chokidar version: ${version}`);

// ============================================================
// Patch handler.js
// ============================================================
patchFile('handler.js', [
  {
    description: 'Add CHOK-INTERNAL debug function',
    find: '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });',
    replace: `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// --- PATCHED: deep diagnostic logging ---
function _chokDebug(area, msg, extra) {
  const ts = new Date().toISOString();
  const hr = (typeof performance !== 'undefined' ? performance.now() : Date.now()).toFixed(1);
  const ext = extra ? ' ' + JSON.stringify(extra) : '';
  try { process.stderr.write('[CHOK-INTERNAL ' + ts + ' +' + hr + 'ms] [' + area + '] ' + msg + ext + '\\n'); } catch(e) {}
}
// --- END PATCH ---`,
  },
  {
    description: 'Log createFsWatchInstance calls and results',
    find: 'function createFsWatchInstance(path, options, listener, errHandler, emitRaw) {\n    const handleEvent = (rawEvent, evPath) => {',
    replace: `function createFsWatchInstance(path, options, listener, errHandler, emitRaw) {
    _chokDebug('fs.watch', 'createFsWatchInstance called', {path, persistent: options.persistent});
    const handleEvent = (rawEvent, evPath) => {
        _chokDebug('fs.watch', 'handleEvent fired', {path, rawEvent, evPath});`,
  },
  {
    description: 'Log fs.watch result',
    find: `        return (0, fs_1.watch)(path, {
            persistent: options.persistent,
        }, handleEvent);
    }
    catch (error) {
        errHandler(error);`,
    replace: `        const watcher = (0, fs_1.watch)(path, {
            persistent: options.persistent,
        }, handleEvent);
        _chokDebug('fs.watch', 'fs.watch() succeeded', {path, watcherType: typeof watcher});
        return watcher;
    }
    catch (error) {
        _chokDebug('fs.watch', 'fs.watch() FAILED', {path, error: error.message, code: error.code});
        errHandler(error);`,
  },
  {
    description: 'Log _watchWithNodeFs entry',
    find: '    _watchWithNodeFs(path, listener) {\n        const opts = this.fsw.options;',
    replace: `    _watchWithNodeFs(path, listener) {
        _chokDebug('NodeFsHandler', '_watchWithNodeFs called', {path, usePolling: this.fsw.options.usePolling});
        const opts = this.fsw.options;`,
  },
  {
    description: 'Log _handleFile entry and "already being watched" check',
    find: `    _handleFile(file, stats, initialAdd) {
        if (this.fsw.closed) {
            return;
        }
        const dirname = sysPath.dirname(file);
        const basename = sysPath.basename(file);
        const parent = this.fsw._getWatchedDir(dirname);
        // stats is always present
        let prevStats = stats;
        // if the file is already being watched, do nothing
        if (parent.has(basename))
            return;`,
    replace: `    _handleFile(file, stats, initialAdd) {
        if (this.fsw.closed) {
            return;
        }
        const dirname = sysPath.dirname(file);
        const basename = sysPath.basename(file);
        const parent = this.fsw._getWatchedDir(dirname);
        // stats is always present
        let prevStats = stats;
        // if the file is already being watched, do nothing
        if (parent.has(basename)) {
            _chokDebug('NodeFsHandler', '_handleFile: file ALREADY WATCHED, skipping', {file, dirname, basename});
            return;
        }
        _chokDebug('NodeFsHandler', '_handleFile: setting up watch', {file, dirname, basename, initialAdd, ignoreInitial: this.fsw.options.ignoreInitial});`,
  },
  {
    description: 'Log _addToNodeFs entry, ignored checks, and stat results',
    find: `    async _addToNodeFs(path, initialAdd, priorWh, depth, target) {
        const ready = this.fsw._emitReady;
        if (this.fsw._isIgnored(path) || this.fsw.closed) {
            ready();
            return false;
        }
        const wh = this.fsw._getWatchHelpers(path);`,
    replace: `    async _addToNodeFs(path, initialAdd, priorWh, depth, target) {
        _chokDebug('NodeFsHandler', '_addToNodeFs called', {path, initialAdd, depth, target, closed: this.fsw.closed});
        const ready = this.fsw._emitReady;
        const isIgnoredResult = this.fsw._isIgnored(path);
        if (isIgnoredResult || this.fsw.closed) {
            _chokDebug('NodeFsHandler', '_addToNodeFs: SKIPPED (ignored or closed)', {path, isIgnored: isIgnoredResult, closed: this.fsw.closed});
            ready();
            return false;
        }
        const wh = this.fsw._getWatchHelpers(path);
        _chokDebug('NodeFsHandler', '_addToNodeFs: watchHelpers', {path, watchPath: wh.watchPath, statMethod: wh.statMethod});`,
  },
  {
    description: 'Log stat result in _addToNodeFs',
    find: `            const stats = await statMethods[wh.statMethod](wh.watchPath);
            if (this.fsw.closed)
                return;
            if (this.fsw._isIgnored(wh.watchPath, stats)) {`,
    replace: `            const stats = await statMethods[wh.statMethod](wh.watchPath);
            _chokDebug('NodeFsHandler', '_addToNodeFs: stat result', {watchPath: wh.watchPath, isFile: stats.isFile(), isDir: stats.isDirectory(), isSymlink: stats.isSymbolicLink(), size: stats.size, mtime: stats.mtimeMs});
            if (this.fsw.closed)
                return;
            const isIgnoredWithStats = this.fsw._isIgnored(wh.watchPath, stats);
            _chokDebug('NodeFsHandler', '_addToNodeFs: isIgnored(with stats)?', {watchPath: wh.watchPath, isIgnored: isIgnoredWithStats});
            if (isIgnoredWithStats) {`,
  },
  {
    description: 'Log stat error in _addToNodeFs',
    find: `        catch (error) {
            if (this.fsw._handleError(error)) {
                ready();
                return path;
            }
        }`,
    replace: `        catch (error) {
            _chokDebug('NodeFsHandler', '_addToNodeFs: STAT ERROR', {path, watchPath: wh.watchPath, error: error.message, code: error.code});
            if (this.fsw._handleError(error)) {
                ready();
                return path;
            }
        }`,
  },
]);

// ============================================================
// Patch index.js
// ============================================================
patchFile('index.js', [
  {
    description: 'Add CHOK-INTERNAL debug function to index.js',
    find: '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });',
    replace: `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// --- PATCHED: deep diagnostic logging ---
function _chokDebug(area, msg, extra) {
  const ts = new Date().toISOString();
  const hr = (typeof performance !== 'undefined' ? performance.now() : Date.now()).toFixed(1);
  const ext = extra ? ' ' + JSON.stringify(extra) : '';
  try { process.stderr.write('[CHOK-INTERNAL ' + ts + ' +' + hr + 'ms] [' + area + '] ' + msg + ext + '\\n'); } catch(e) {}
}
// --- END PATCH ---`,
  },
  {
    description: 'Log add() paths and normalization',
    find: `    add(paths_, _origAdd, _internal) {
        const { cwd } = this.options;
        this.closed = false;
        this._closePromise = undefined;
        let paths = unifyPaths(paths_);`,
    replace: `    add(paths_, _origAdd, _internal) {
        const { cwd } = this.options;
        _chokDebug('FSWatcher', 'add() called', {paths_: Array.isArray(paths_) ? paths_ : [paths_], cwd, _origAdd, _internal: !!_internal});
        this.closed = false;
        this._closePromise = undefined;
        let paths = unifyPaths(paths_);
        _chokDebug('FSWatcher', 'add() after unifyPaths', {paths});`,
  },
  {
    description: 'Log add() after cwd resolution',
    find: `        if (cwd) {
            paths = paths.map((path) => {
                const absPath = getAbsolutePath(path, cwd);
                // Check \`path\` instead of \`absPath\` because the cwd portion can't be a glob
                return absPath;
            });
        }`,
    replace: `        if (cwd) {
            paths = paths.map((path) => {
                const absPath = getAbsolutePath(path, cwd);
                // Check \`path\` instead of \`absPath\` because the cwd portion can't be a glob
                return absPath;
            });
            _chokDebug('FSWatcher', 'add() after cwd resolution', {paths, cwd});
        }`,
  },
  {
    description: 'Log _isIgnored decisions',
    find: `    _isIgnored(path, stats) {
        if (this.options.atomic && DOT_RE.test(path))
            return true;`,
    replace: `    _isIgnored(path, stats) {
        if (this.options.atomic && DOT_RE.test(path))
            return true;
        _chokDebug('FSWatcher', '_isIgnored called', {path, hasStats: !!stats, hasCachedIgnored: !!this._userIgnored});`,
  },
  {
    description: 'Log _isIgnored result',
    find: `        return this._userIgnored(path, stats);
    }`,
    replace: `        const result = this._userIgnored(path, stats);
        _chokDebug('FSWatcher', '_isIgnored result', {path, hasStats: !!stats, ignored: result});
        return result;
    }`,
  },
  {
    description: 'Log _emit events',
    find: `    async _emit(event, path, stats) {
        if (this.closed)
            return;`,
    replace: `    async _emit(event, path, stats) {
        _chokDebug('FSWatcher', '_emit called', {event, path});
        if (this.closed)
            return;`,
  },
]);

console.log('[PATCH-CHOKIDAR] Done! All patches applied.');

