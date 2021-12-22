export default class TaskRule {
  async cacheKey(_args: string): Promise<string> {
    return '';
  }

  watchPaths(): string[] {
    return [];
  }
}
