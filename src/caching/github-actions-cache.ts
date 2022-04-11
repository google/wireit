/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
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
import {optimizeCopies} from '../util/optimize-fs-ops.js';

import type {CompressionMethod} from '@actions/cache/lib/internal/constants.js';
import type {
  ReserveCacheRequest,
  ReserveCacheResponse,
  ITypedResponseWithError,
  ArtifactCacheEntry,
} from '@actions/cache/lib/internal/contracts.js';
import type {Cache, CacheHit} from './cache.js';
import type {ScriptReference, ScriptStateString} from '../script.js';

// TODO(aomarks) Drop the dependency on @actions/cache by writing our own
// implementation.
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
// The logic it here could be re-implemented in a fairly minimal way. The main
// tricky part are the way it handles tarball generation across platforms
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

  constructor() {
    // The ACTIONS_CACHE_URL and ACTIONS_RUNTIME_TOKEN environment variables are
    // automatically provided to GitHub Actions re-usable workflows. However,
    // they are _not_ provided to regular "run" scripts. For this reason, we
    // re-export those variables so that all "run" scripts can access them using
    // the "google/wireit@setup-github-actions-caching/v1" re-usable workflow.
    const baseUrl = process.env['ACTIONS_CACHE_URL'];
    if (!baseUrl) {
      throw new GitHubActionsCacheError(
        'invalid-usage',
        'The ACTIONS_CACHE_URL variable was not set, but is required when ' +
          'WIREIT_CACHE=github. Use the google/wireit@setup-github-cache/v1 ' +
          'action to automatically set environment variables.'
      );
    }
    if (!baseUrl.endsWith('/')) {
      // Internally, the @actions/cache library expects the URL to end with a
      // slash. While we could be more lenient, we want to match the behavior of
      // any other calls happening inside that library which we don't control.
      throw new GitHubActionsCacheError(
        'invalid-usage',
        `The ACTIONS_CACHE_URL must end in a forward-slash, got ${JSON.stringify(
          baseUrl
        )}.`
      );
    }
    this.#baseUrl = baseUrl;

    const authToken = process.env['ACTIONS_RUNTIME_TOKEN'];
    if (!authToken) {
      throw new GitHubActionsCacheError(
        'invalid-usage',
        'The ACTIONS_RUNTIME_TOKEN variable was not set, but is required when ' +
          'WIREIT_CACHE=github. Use the google/wireit@setup-github-cache/v1 ' +
          'action to automatically set environment variables.'
      );
    }
    this.#authToken = authToken;
  }

  async get(
    script: ScriptReference,
    stateStr: ScriptStateString
  ): Promise<CacheHit | undefined> {
    const compressionMethod = await GitHubActionsCache.#compressionMethod;
    const location = await this.#checkForCacheEntry(
      this.#computeCacheKey(script),
      this.#computeVersion(stateStr, compressionMethod)
    );
    if (location === undefined) {
      // No cache hit.
      return undefined;
    }
    return new GitHubActionsCacheHit(location, compressionMethod);
  }

  async set(
    script: ScriptReference,
    stateStr: ScriptStateString,
    relativeFiles: string[]
  ): Promise<void> {
    const compressionMethod = await GitHubActionsCache.#compressionMethod;
    const tarballPath = await this.#makeTarball(
      relativeFiles.map((file) => pathlib.join(script.packageDir, file)),
      compressionMethod
    );
    try {
      const tarBytes = cacheUtils.getArchiveFileSizeInBytes(tarballPath);
      // Reference: https://github.com/actions/toolkit/blob/f8a69bc473af4a204d0c03de61d5c9d1300dfb17/packages/cache/src/cache.ts#L174
      const maxBytes = 10 * 1024 * 1024 * 1024; // 10GB
      if (tarBytes > maxBytes) {
        return;
      }
      const id = await this.#reserveCacheEntry(
        this.makeAuthenticatedHttpClient(),
        this.#computeCacheKey(script),
        this.#computeVersion(stateStr, compressionMethod),
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
      await cacheUtils.unlinkFile(tarballPath);
    }
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
          process.env.ImageOS,
        ].join('\x1E') // ASCII record seperator
      )
      .digest('hex');
  }

  /**
   * Make an HTTP client which always sends "Authorization: Bearer <token>"
   * header.
   */
  makeAuthenticatedHttpClient(): HttpClient {
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
    const optimized = optimizeCopies(paths);
    const folder = await cacheUtils.createTempDirectory();
    await createTar(folder, optimized, compressionMethod);
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
    const httpClient = this.makeAuthenticatedHttpClient();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const response: ITypedResponseWithError<ArtifactCacheEntry> =
      await retryTypedResponse('getCacheEntry', async () =>
        httpClient.getJson<ArtifactCacheEntry>(
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

  constructor(location: string, compressionMethod: CompressionMethod) {
    this.#url = location;
    this.#compressionMethod = compressionMethod;
  }

  async apply(): Promise<void> {
    console.log('TARBALLS URL', this.#url);
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
    } finally {
      await cacheUtils.unlinkFile(archivePath);
    }
  }
}

/**
 * An exception thrown by {@link GitHubActionsCache}.
 *
 * Note we don't use {@link WireitError} here because we don't have the full
 * context of the script we're trying to evaluate.
 */
export class GitHubActionsCacheError extends Error {
  reason: 'invalid-usage';

  constructor(reason: GitHubActionsCacheError['reason'], message: string) {
    super(message);
    this.reason = reason;
  }
}
