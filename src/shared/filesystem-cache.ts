import type {Cache} from './cache.js';

export class FilesystemCache implements Cache {
  async getOutputs(
    _packageJsonPath: string,
    _taskName: string,
    _cacheKey: string
  ): Promise<FilesystemCachedOutput> {
    return new FilesystemCachedOutput();
  }

  async saveOutputs(
    _packageJsonPath: string,
    _taskName: string,
    _cacheKey: string,
    _taskOutputGlobs: string[]
  ): Promise<void> {
    return undefined;
  }
}

class FilesystemCachedOutput {
  async apply(): Promise<void> {
    return undefined;
  }
}
