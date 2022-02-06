export interface Cache {
  getOutput(
    packageJsonPath: string,
    scriptName: string,
    cacheKey: string,
    scriptOutputGlobs: string[]
  ): Promise<CachedOutput | undefined>;

  saveOutput(
    packageJsonPath: string,
    scriptName: string,
    cacheKey: string,
    scriptOutputGlobs: string[]
  ): Promise<void>;
}

export interface CachedOutput {
  apply(): Promise<void>;
}
