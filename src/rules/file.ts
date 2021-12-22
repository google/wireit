import {stat} from 'fs/promises';

export default class FileRule {
  async cacheKey(filePath: string): Promise<string> {
    const stats = await stat(filePath);
    return String(Math.max(stats.mtimeMs, stats.ctimeMs));
  }

  watchPaths(filePath: string): string[] {
    return [filePath];
  }
}
