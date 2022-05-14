/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import * as fs from 'fs/promises';
import * as https from 'https';
import {createHash} from 'crypto';
import * as cacheUtils from '@actions/cache/lib/internal/cacheUtils.js';
import {extractTar} from '@actions/cache/lib/internal/tar.js';
import {
  saveCache,
  downloadCache,
} from '@actions/cache/lib/internal/cacheHttpClient.js';
import {scriptReferenceToString} from '../script.js';
import {getScriptDataDir} from '../util/script-data-dir.js';
import {CompressionMethod} from '@actions/cache/lib/internal/constants.js';
import {execFile} from 'child_process';

import type * as http from 'http';
import type {Cache, CacheHit} from './cache.js';
import type {ScriptReference, ScriptStateString} from '../script.js';
import type {Logger} from '../logging/logger.js';
import type {RelativeEntry} from '../util/glob.js';
import type {Result} from '../error.js';

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
  readonly #baseUrl: string;
  readonly #authToken: string;
  readonly #logger: Logger;

  /**
   * Once we've hit a 429 rate limit error from GitHub, simply stop hitting the
   * cache for the remainder of this Wireit process. Caching is not critical,
   * it's just an optimization.
   *
   * TODO(aomarks) We could be a little smarter and do retries, but this at
   * least should stop builds breaking in the short-term.
   */
  #hitRateLimit = false;

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
    //
    // https://github.com/actions/toolkit/blob/500d0b42fee2552ae9eeb5933091fe2fbf14e72d/packages/cache/src/internal/cacheHttpClient.ts#L38
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

    // https://github.com/actions/toolkit/blob/500d0b42fee2552ae9eeb5933091fe2fbf14e72d/packages/cache/src/internal/cacheHttpClient.ts#L63
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
    if (this.#hitRateLimit) {
      return undefined;
    }

    const version = this.#computeVersion(stateStr);
    const key = this.#computeCacheKey(script);
    const url = new URL('_apis/artifactcache/cache', this.#baseUrl);
    url.searchParams.set('keys', key);
    url.searchParams.set('version', version);

    const {req, resPromise} = this.#request(url);
    req.end();
    const res = await resPromise;

    if (res.statusCode === /* No Content */ 204) {
      return undefined;
    }

    if (isOk(res)) {
      const {archiveLocation} = JSON.parse(await readBody(res)) as {
        archiveLocation: string;
      };
      return new GitHubActionsCacheHit(archiveLocation);
    }

    if (res.statusCode === /* Too Many Requests */ 429) {
      this.#onRateLimit(script);
      return;
    }

    throw new Error(
      `GitHub Cache check HTTP ${String(res.statusCode)} error: ` +
        (await readBody(res))
    );
  }

  async set(
    script: ScriptReference,
    stateStr: ScriptStateString,
    relativeFiles: RelativeEntry[]
  ): Promise<boolean> {
    if (this.#hitRateLimit) {
      return false;
    }

    const absFiles = relativeFiles.map((rel) =>
      pathlib.join(script.packageDir, rel.path)
    );
    const tempDir = await makeTempDir(script);
    const tarballPath = await this.#makeTarball([...absFiles], tempDir);

    try {
      const version = this.#computeVersion(stateStr);
      const {size: tarBytes} = await fs.stat(tarballPath);
      // Reference:
      // https://github.com/actions/toolkit/blob/f8a69bc473af4a204d0c03de61d5c9d1300dfb17/packages/cache/src/cache.ts#L174
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
        script,
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
        try {
          await saveCache(id, tarballPath);
        } catch (error) {
          if (/\W429\W/.test((error as Error).message)) {
            this.#onRateLimit(script);
            return false;
          }
          throw error;
        }
      }
    } finally {
      await fs.rm(tempDir, {recursive: true});
    }
    return true;
  }

  #request(
    url: URL,
    options?: http.RequestOptions
  ): {req: http.ClientRequest; resPromise: Promise<http.IncomingMessage>} {
    return request(url, {
      ...options,
      headers: {
        // https://github.com/actions/toolkit/blob/500d0b42fee2552ae9eeb5933091fe2fbf14e72d/packages/cache/src/internal/cacheHttpClient.ts#L55
        accept: 'application/json;api-version=6.0-preview.1',
        // https://github.com/actions/toolkit/blob/500d0b42fee2552ae9eeb5933091fe2fbf14e72d/packages/http-client/src/auth.ts#L46
        authorization: `Bearer ${this.#authToken}`,
        ...options?.headers,
      },
    });
  }

  /**
   * Log a message about hitting a rate limit, and disable caching for the
   * remainder of this process.
   */
  #onRateLimit(script: ScriptReference): void {
    if (this.#hitRateLimit) {
      return;
    }
    this.#logger.log({
      script,
      type: 'info',
      detail: 'generic',
      message: `Hit GitHub Actions cache rate limit, caching disabled.`,
    });
    this.#hitRateLimit = true;
  }

  #computeCacheKey(script: ScriptReference): string {
    return createHash('sha256')
      .update(scriptReferenceToString(script))
      .digest('hex');
  }

  #computeVersion(stateStr: ScriptStateString): string {
    return createHash('sha256')
      .update(
        [
          stateStr,
          'gzip', // e.g. zstd, gzip
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
   * Create a tarball file in a local temp directory containing the given paths.
   *
   * @returns The full path to the tarball file on disk.
   */
  async #makeTarball(paths: string[], tempDir: string): Promise<string> {
    // Create a manifest file so that we can pass a large number of files to
    // tar.
    const manifestPath = pathlib.join(tempDir, 'manifest.txt');
    await fs.writeFile(manifestPath, paths.join('\n'), 'utf8');
    const tarballPath = pathlib.join(tempDir, 'cache.tgz');
    await new Promise<void>((resolve, reject) => {
      execFile(
        'tar',
        [
          // Use the newer standardized tar format.
          '--posix',
          // Use gzip compression.
          //
          // TODO(aomarks) zstd is faster and has better performance, but it's
          // availability is unreliable, and appears to have a bug on Windows
          // (https://github.com/actions/cache/issues/301). Investigate and
          // enable if easy.
          '--gzip',
          '--create',
          '--file',
          tarballPath,
          // Use absolute paths (note we use the short form because the long
          // form is --absolute-names on GNU tar, but --absolute-paths on BSD
          // tar).
          '-P',
          // We have a complete list of files and directories, so we don't need
          // or want tar to automatically expand directories. This also allows
          // us to create empty directories, even if they aren't actually empty
          // on disk.
          '--no-recursion',
          '--files-from',
          manifestPath,
        ],
        (error: unknown) => {
          if (error != null) {
            reject(`tar error: ${String(error)}`);
          } else {
            resolve();
          }
        }
      );
    });
    return tarballPath;
  }

  /**
   * Reserve a cache entry.
   *
   * @returns A numeric cache id the cache entry was reserved for us, or
   * undefined if the cache entry was already reserved.
   */
  async #reserveCacheEntry(
    script: ScriptReference,
    key: string,
    version: string,
    cacheSize: number
  ): Promise<number | undefined> {
    const url = new URL('_apis/artifactcache/caches', this.#baseUrl);
    const reqBody = JSON.stringify({
      key,
      version,
      cacheSize,
    });
    const {req, resPromise} = this.#request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
    });
    req.end(reqBody);
    const res = await resPromise;

    if (isOk(res)) {
      const resData = JSON.parse(await readBody(res)) as {
        cacheId: number;
      };
      return resData.cacheId;
    }

    if (res.statusCode === /* Conflict */ 409) {
      return undefined;
    }

    if (res.statusCode === /* Too Many Requests */ 429) {
      this.#onRateLimit(script);
      return undefined;
    }

    throw new Error(
      `GitHub Cache reserve HTTP ${String(
        res.statusCode
      )} error: ${await readBody(res)}`
    );
  }
}

class GitHubActionsCacheHit implements CacheHit {
  #url: string;
  #applied = false;

  constructor(location: string) {
    this.#url = location;
  }

  async apply(): Promise<void> {
    if (this.#applied) {
      throw new Error('GitHubActionsCacheHit.apply was called more than once');
    }
    this.#applied = true;
    const archivePath = pathlib.join(
      await cacheUtils.createTempDirectory(),
      cacheUtils.getCacheFileName(CompressionMethod.Gzip)
    );
    try {
      // TODO(aomarks) We should recover from rate limits and other HTTP errors
      // here, but we currently seem to just get an exception about the tarball
      // being invalid so we can't really tell what's going on.
      await downloadCache(this.#url, archivePath);
      await extractTar(archivePath, CompressionMethod.Gzip);
    } finally {
      await cacheUtils.unlinkFile(archivePath);
    }
  }
}

function request(
  url: URL | string,
  options?: http.RequestOptions
): {
  req: http.ClientRequest;
  resPromise: Promise<http.IncomingMessage>;
} {
  const opts = {
    ...options,
    headers: {
      // https://github.com/actions/toolkit/blob/500d0b42fee2552ae9eeb5933091fe2fbf14e72d/packages/cache/src/internal/cacheHttpClient.ts#L67
      'user-agent': 'actions/cache',
      ...options?.headers,
    },
  };
  let req!: http.ClientRequest;
  const resPromise = new Promise<http.IncomingMessage>((resolve, reject) => {
    req = https.request(url, opts, (res) => {
      resolve(res);
    });
    req.on('error', (error) => {
      reject(error);
    });
  });
  return {req, resPromise};
}

function isOk(res: http.IncomingMessage): boolean {
  return (
    res.statusCode !== undefined &&
    res.statusCode >= 200 &&
    res.statusCode < 300
  );
}

function readBody(res: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });
  return new Promise((resolve, reject) => {
    res.on('error', (error: Error) => {
      reject(error);
    });
    res.on('end', () => {
      resolve(Buffer.concat(chunks).toString());
    });
  });
}

function makeTempDir(script: ScriptReference): Promise<string> {
  return fs.mkdtemp(pathlib.join(getScriptDataDir(script), 'temp'));
}
