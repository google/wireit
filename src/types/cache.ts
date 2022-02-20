export interface CacheKey {
  command: string;
  // Must be sorted by filename.
  files: {[fileName: string]: FileContentHash};
  // Must be sorted by script name.
  dependencies: {[scriptName: string]: CacheKey};
  // Must be sorted by script name.
  npmPackageLocks: {[fileName: string]: FileContentHash};
  // Must preserve the specified order, because the meaning of `!` depends on
  // which globs preceded it.
  outputGlobs: string[];
  // Must preserve the specified order, because the meaning of `!` depends on
  // which globs preceded it.
  incrementalBuildFiles: string[];
}

// TODO(aomarks) What about permission bits?
export interface FileContentHash {
  sha256: string;
}

export interface ScriptStatus {
  cacheKey: CacheKey;
}
