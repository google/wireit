/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import * as fs from 'fs/promises';
import {createHash} from 'crypto';
import * as cacheUtils from '@actions/cache/lib/internal/cacheUtils.js';
import {createTar, extractTar} from '@actions/cache/lib/internal/tar.js';
import {retryTypedResponse} from '@actions/cache/lib/internal/requestUtils.js';
import {
  saveCache,
  downloadCache,
} from '@actions/cache/lib/internal/cacheHttpClient.js';
import {HttpClient} from '@actions/http-client';
import {BearerCredentialHandler} from '@actions/http-client/auth.js';
import {isSuccessStatusCode} from '@actions/cache/lib/internal/requestUtils.js';
import {scriptReferenceToString} from '../script.js';
import {getScriptDataDir} from '../util/script-data-dir.js';

import type {CompressionMethod} from '@actions/cache/lib/internal/constants.js';
import type {
  ReserveCacheRequest,
  ReserveCacheResponse,
  ITypedResponseWithError,
  ArtifactCacheEntry,
} from '@actions/cache/lib/internal/contracts.js';
import type {Cache, CacheHit} from './cache.js';
import type {ScriptReference, ScriptStateString} from '../script.js';
import type {Logger} from '../logging/logger.js';
import type {RelativeEntry} from '../util/glob.js';
import {Result} from '../error.js';

// TODO(aomarks) Consider dropping the dependency on @actions/cache by writing
// our own implementation. See https://github.com/google/wireit/issues/107 for
// details.
//
// The public API provided by the @actions/cache package doesn't exactly meet
// our needs, because it automatically uses the file paths that are included in
// the tarball as part of the cache entry version (see
// https://github.com/actions/toolkit/blob/7654d97eb6c4a3d564f036a2d4a783ae9105ec07/packages/cache/src/internal/cacheHttpClient.ts#L70),
// and implements globbing differently.
//
// We want complete control over our cache key, instead of having it be
// generated automatically based on file paths.
//
// For this reason, we are reaching into the "internal/" directory of this
// package to get more control. This is bad because those modules could change
// at any time, which is why we currently have a strict ("=") version pin in our
// package.json.
//
// The @actions/cache package is also our largest dependency by far. It's 22MB,
// and adds 63 transitive dependencies.
//
// The logic in here could be re-implemented in a fairly minimal way. The main
// tricky part is the way it handles tarball generation across platforms
// (https://github.com/actions/toolkit/blob/7654d97eb6c4a3d564f036a2d4a783ae9105ec07/packages/cache/src/internal/tar.ts).

/**
 * Caches script output to the GitHub Actions caching service.
 */
export class GitHubActionsCache implements Cache {
  static #compressionMethodPromise?: Promise<CompressionMethod>;

  static get #compressionMethod(): Promise<CompressionMethod> {
    // We only need to do this once per Wireit process. It's expensive because
    // it spawns a child process to test the tar version.
    if (this.#compressionMethodPromise === undefined) {
      this.#compressionMethodPromise = cacheUtils.getCompressionMethod();
    }
    return this.#compressionMethodPromise;
  }

  readonly #baseUrl: string;
  readonly #authToken: string;
  readonly #logger: Logger;

  private constructor(logger: Logger, baseUrl: string, authToken: string) {
    this.#baseUrl = baseUrl;
    this.#authToken = authToken;
    this.#logger = logger;
  }

  static create(
    logger: Logger
  ): Result<GitHubActionsCache, {reason: 'invalid-usage'; message: string}> {
    // The ACTIONS_CACHE_URL and ACTIONS_RUNTIME_TOKEN environment variables are
    // automatically provided to GitHub Actions re-usable workflows. However,
    // they are _not_ provided to regular "run" scripts. For this reason, we
    // re-export those variables so that all "run" scripts can access them using
    // the "google/wireit@setup-github-actions-caching/v1" re-usable workflow.
    const baseUrl = process.env['ACTIONS_CACHE_URL'];
    if (!baseUrl) {
      return {
        ok: false,
        error: {
          reason: 'invalid-usage',
          message:
            'The ACTIONS_CACHE_URL variable was not set, but is required when ' +
            'WIREIT_CACHE=github. Use the google/wireit@setup-github-cache/v1 ' +
            'action to automatically set environment variables.',
        },
      };
    }
    if (!baseUrl.endsWith('/')) {
      // Internally, the @actions/cache library expects the URL to end with a
      // slash. While we could be more lenient, we want to match the behavior of
      // any other calls happening inside that library which we don't control.
      return {
        ok: false,
        error: {
          reason: 'invalid-usage',
          message: `The ACTIONS_CACHE_URL must end in a forward-slash, got ${JSON.stringify(
            baseUrl
          )}.`,
        },
      };
    }

    const authToken = process.env['ACTIONS_RUNTIME_TOKEN'];
    if (!authToken) {
      return {
        ok: false,
        error: {
          reason: 'invalid-usage',
          message:
            'The ACTIONS_RUNTIME_TOKEN variable was not set, but is required when ' +
            'WIREIT_CACHE=github. Use the google/wireit@setup-github-cache/v1 ' +
            'action to automatically set environment variables.',
        },
      };
    }

    return {
      ok: true,
      value: new GitHubActionsCache(logger, baseUrl, authToken),
    };
  }

  async get(
    script: ScriptReference,
    stateStr: ScriptStateString
  ): Promise<CacheHit | undefined> {
    const compressionMethod = await GitHubActionsCache.#compressionMethod;
    const version = this.#computeVersion(stateStr, compressionMethod);
    const location = await this.#checkForCacheEntry(
      this.#computeCacheKey(script),
      version
    );
    if (location === undefined) {
      // No cache hit.
      return undefined;
    }
    return new GitHubActionsCacheHit(
      location,
      compressionMethod,
      this.#emptyDirectoriesManifestPath(script, version)
    );
  }

  async set(
    script: ScriptReference,
    stateStr: ScriptStateString,
    relativeFiles: RelativeEntry[]
  ): Promise<boolean> {
    // We're going to build a tarball. We do this by passing paths to the "tar"
    // command. When we pass a directory to "tar", all of its children are
    // implicitly included. This is a problem, because sometimes we want to add
    // a directory, but only a subset of its children (or none of them), because
    // of exclusion patterns in the "output" globs.
    //
    // To work around this problem, we never pass directories to "tar". Instead,
    // we enumerate every specific file. This works fine, except for empty
    // directories. If a directory was explicitly listed for inclusion, and it
    // happens to be empty, we should cache an empty directory.
    //
    // So we need special handling for empty directories. If there are empty
    // directories, we create a special "empty directories manifest" file, and
    // include that in the tarball at a predictable location (inside the
    // ".wireit" folder so that it won't collide with a user file). Then when we
    // untar, we check for that manifest, create any missing directories listed
    // inside it, and delete the manifest.

    const files = new Set<string>();
    const emptyDirs = new Set<string>();
    {
      const nonEmptyDirs = new Set<string>();
      for (const {path, dirent} of relativeFiles) {
        const absPath = pathlib.join(script.packageDir, path);
        if (dirent.isDirectory()) {
          // Initially assume every directory might be empty. We might see a
          // directory entry after a file that's in it. We'll filter it down
          // after this loop.
          emptyDirs.add(absPath);
        } else {
          files.add(absPath);
          // Add all parent directories of this file to set of non-empty
          // directories.
          let cur = pathlib.dirname(absPath);
          while (!nonEmptyDirs.has(cur)) {
            // Note if we've already added the child, we must have already added
            // all of its parents too.
            nonEmptyDirs.add(cur);
            cur = pathlib.dirname(cur);
          }
        }
      }
      for (const nonEmptyDir of nonEmptyDirs) {
        emptyDirs.delete(nonEmptyDir);
      }
    }

    const compressionMethod = await GitHubActionsCache.#compressionMethod;
    const version = this.#computeVersion(stateStr, compressionMethod);

    let emptyDirsManifestPath: string | undefined;
    if (emptyDirs.size > 0) {
      const emptyDirsManifest = JSON.stringify([...emptyDirs]);
      emptyDirsManifestPath = this.#emptyDirectoriesManifestPath(
        script,
        version
      );
      await fs.mkdir(pathlib.dirname(emptyDirsManifestPath), {recursive: true});
      await fs.writeFile(emptyDirsManifestPath, emptyDirsManifest, {
        encoding: 'utf8',
      });
      files.add(emptyDirsManifestPath);
    }

    const tarballPath = await this.#makeTarball([...files], compressionMethod);
    try {
      const tarBytes = cacheUtils.getArchiveFileSizeInBytes(tarballPath);
      // Reference: https://github.com/actions/toolkit/blob/f8a69bc473af4a204d0c03de61d5c9d1300dfb17/packages/cache/src/cache.ts#L174
      const GB = 1024 * 1024 * 1024;
      const maxBytes = 10 * GB;
      if (tarBytes > maxBytes) {
        this.#logger.log({
          script,
          type: 'info',
          detail: 'generic',
          message:
            `Output was too big to be cached: ` +
            `${Math.round(tarBytes / GB)}GB > ` +
            `${Math.round(maxBytes / GB)}GB.`,
        });
        return false;
      }
      const id = await this.#reserveCacheEntry(
        this.#makeAuthenticatedHttpClient(),
        this.#computeCacheKey(script),
        version,
        tarBytes
      );
      // It's likely that we'll occasionally fail to reserve an entry and get
      // undefined here, especially when running multiple GitHub Action jobs in
      // parallel with the same scripts, because there is a window of time
      // between calling "get" and "set" on the cache in which another worker
      // could have reserved the entry before us. Non fatal, just don't save.
      if (id !== undefined) {
        await saveCache(id, tarballPath);
      }
    } finally {
      // Delete the tarball.
      const tarballDeleted = cacheUtils.unlinkFile(tarballPath);
      // Also delete the empty directories manifest file.
      if (emptyDirsManifestPath !== undefined) {
        await fs.unlink(emptyDirsManifestPath);
      }
      await tarballDeleted;
    }
    return true;
  }

  #emptyDirectoriesManifestPath(
    script: ScriptReference,
    version: string
  ): string {
    return pathlib.join(
      getScriptDataDir(script),
      `github-cache-empty-directories-manifest-${version}.json`
    );
  }

  #computeCacheKey(script: ScriptReference): string {
    return createHash('sha256')
      .update(scriptReferenceToString(script))
      .digest('hex');
  }

  #computeVersion(
    stateStr: ScriptStateString,
    compressionMethod: CompressionMethod
  ): string {
    return createHash('sha256')
      .update(
        [
          stateStr,
          compressionMethod, // e.g. zstd, gzip
          // The ImageOS environment variable tells us which operating system
          // version is being used for the worker VM (e.g. "ubuntu20",
          // "macos11"). We already include process.platform in ScriptState, but
          // this is more specific.
          //
          // There is also an ImageVersion variable (e.g. "20220405.4") which we
          // could consider including, but it probably changes frequently and is
          // unlikely to affect output, so we prefer the higher cache hit rate.
          process.env.ImageOS ?? '',
        ].join('\x1E') // ASCII record seperator
      )
      .digest('hex');
  }

  /**
   * Make an HTTP client which always sends "Authorization: Bearer <token>"
   * header.
   */
  #makeAuthenticatedHttpClient(): HttpClient {
    const bearerCredentialHandler = new BearerCredentialHandler(
      this.#authToken
    );
    return new HttpClient('actions/cache', [bearerCredentialHandler], {
      headers: {
        Accept: 'application/json;api-version=6.0-preview.1',
      },
    });
  }

  /**
   * Create a tarball file in a local temp directory containing the given paths.
   *
   * @returns The full path to the tarball file on disk.
   */
  async #makeTarball(
    paths: string[],
    compressionMethod: CompressionMethod
  ): Promise<string> {
    const folder = await cacheUtils.createTempDirectory();
    await createTar(folder, paths, compressionMethod);
    const path = pathlib.join(
      folder,
      cacheUtils.getCacheFileName(compressionMethod)
    );
    return path;
  }

  /**
   * Check for a cache entry.
   *
   * @returns A tarball URL if this cache entry exists, or undefined if it does
   * not exist.
   */
  async #checkForCacheEntry(
    key: string,
    version: string
  ): Promise<string | undefined> {
    const httpClient = this.#makeAuthenticatedHttpClient();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const response: ITypedResponseWithError<ArtifactCacheEntry> =
      await retryTypedResponse('getCacheEntry', async () =>
        httpClient.getJson<ArtifactCacheEntry>(
          /** For docs on this API, see {@link FakeGitHubActionsCacheServer} */
          `${this.#baseUrl}_apis/artifactcache/cache?keys=${encodeURIComponent(
            key
          )}&version=${version}`
        )
      );
    if (response.statusCode === /* No Content */ 204) {
      return undefined;
    }
    if (
      !isSuccessStatusCode(response.statusCode) ||
      response.error !== undefined ||
      response.result?.archiveLocation === undefined
    ) {
      throw new Error(
        `Error getting cache entry: ${response.statusCode} ${
          response.error?.message ?? '<no error message>'
        }`
      );
    }
    return response.result.archiveLocation;
  }

  /**
   * Reserve a cache entry.
   *
   * @returns A numeric cache id the cache entry was reserved for us, or
   * undefined if the cache entry was already reserved.
   */
  async #reserveCacheEntry(
    httpClient: HttpClient,
    key: string,
    version: string,
    cacheSize: number
  ): Promise<number | undefined> {
    const request: ReserveCacheRequest = {
      key,
      version,
      cacheSize,
    };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const response: ITypedResponseWithError<ReserveCacheResponse> =
      await retryTypedResponse('reserveCache', async () =>
        httpClient.postJson(
          /** For docs on this API, see {@link FakeGitHubActionsCacheServer} */
          `${this.#baseUrl}_apis/artifactcache/caches`,
          request
        )
      );
    if (response.statusCode === /* Conflict */ 409) {
      // This cache entry has already been reserved, so we can't write to it.
      return undefined;
    }
    if (
      !isSuccessStatusCode(response.statusCode) ||
      response.error !== undefined ||
      response.result?.cacheId === undefined
    ) {
      throw new Error(
        `Error reserving cache entry: ${response.statusCode} ${
          response.error?.message ?? '<no error message>'
        }`
      );
    }
    return response.result.cacheId;
  }
}

class GitHubActionsCacheHit implements CacheHit {
  #url: string;
  #compressionMethod: CompressionMethod;
  #applied = false;
  #emptyDirectoriesManifestPath: string;

  constructor(
    location: string,
    compressionMethod: CompressionMethod,
    emptyDirectoriesManifestPath: string
  ) {
    this.#url = location;
    this.#compressionMethod = compressionMethod;
    this.#emptyDirectoriesManifestPath = emptyDirectoriesManifestPath;
  }

  async apply(): Promise<void> {
    if (this.#applied) {
      throw new Error('GitHubActionsCacheHit.apply was called more than once');
    }
    this.#applied = true;
    const archivePath = pathlib.join(
      await cacheUtils.createTempDirectory(),
      cacheUtils.getCacheFileName(this.#compressionMethod)
    );
    try {
      await downloadCache(this.#url, archivePath);
      await extractTar(archivePath, this.#compressionMethod);
      await this.#createEmptyDirectories();
    } finally {
      await cacheUtils.unlinkFile(archivePath);
    }
  }

  async #createEmptyDirectories() {
    let manifest;
    try {
      manifest = await fs.readFile(this.#emptyDirectoriesManifestPath, {
        encoding: 'utf8',
      });
    } catch (error) {
      const {code} = error as {code: string};
      if (code === 'ENOENT') {
        // No empty dirs manifest means no empty dirs which is no problem.
        return;
      }
      throw error;
    }
    const emptyDirs = JSON.parse(manifest) as string[];
    await Promise.all([
      ...emptyDirs.map((dir) => fs.mkdir(dir, {recursive: true})),
      fs.unlink(this.#emptyDirectoriesManifestPath),
    ]);
  }
}
