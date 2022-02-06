export interface Cache {
  getOutputs(
    packageJsonPath: string,
    scriptName: string,
    cacheKey: string,
    scriptOutputGlobs: string[]
  ): Promise<CachedOutput | undefined>;

  saveOutputs(
    packageJsonPath: string,
    scriptName: string,
    cacheKey: string,
    scriptOutputGlobs: string[]
  ): Promise<void>;
}

export interface CachedOutput {
  apply(): Promise<void>;
}
