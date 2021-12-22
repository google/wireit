export default class EnvRule {
  async cacheKey(envName: string): Promise<string | null> {
    return process.env[envName] ?? null;
  }

  watchPaths(): string[] {
    return [];
  }
}
