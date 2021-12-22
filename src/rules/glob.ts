import fastglob from 'fast-glob';

export default class GlobRule {
  async cacheKey(glob: string): Promise<string> {
    const entries = await fastglob(glob, {stats: true});
    let maxModTime = 0;
    for (const entry of entries) {
      const stats = entry.stats!;
      maxModTime = Math.max(maxModTime, stats.mtimeMs, stats.ctimeMs);
    }
    const numFiles = entries.length;
    return `${maxModTime}:${numFiles}`;
  }

  watchPaths(glob: string): string[] {
    return [glob];
  }
}
