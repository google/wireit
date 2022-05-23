/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import * as fs from 'fs/promises';
import * as https from 'https';
import {createHash} from 'crypto';
import {scriptReferenceToString} from '../script.js';
import {getScriptDataDir} from '../util/script-data-dir.js';
import {execFile} from 'child_process';
import {createReadStream, createWriteStream} from 'fs';

import type * as http from 'http';
import type {Cache, CacheHit} from './cache.js';
import type {ScriptReference} from '../script.js';
import type {Fingerprint} from '../fingerprint.js';
import type {Logger} from '../logging/logger.js';
import type {RelativeEntry} from '../util/glob.js';
import type {Result} from '../error.js';

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
    fingerprint: Fingerprint
  ): Promise<CacheHit | undefined> {
    if (this.#hitRateLimit) {
      return undefined;
    }

    const version = this.#computeVersion(fingerprint);
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
      return new GitHubActionsCacheHit(script, archiveLocation);
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
    fingerprint: Fingerprint,
    relativeFiles: RelativeEntry[]
  ): Promise<boolean> {
    if (this.#hitRateLimit) {
      return false;
    }

    const absFiles = relativeFiles.map((rel) =>
      pathlib.join(script.packageDir, rel.path)
    );
    const tempDir = await makeTempDir(script);
    try {
      const tarballPath = await this.#makeTarball([...absFiles], tempDir);
      return await this.#reserveUploadAndCommitTarball(
        script,
        fingerprint,
        tarballPath
      );
    } finally {
      await fs.rm(tempDir, {recursive: true});
    }
  }

  /**
   * @returns True if we reserved, uploaded, and committed the tarball. False if
   * we gave up due to a rate limit error.
   * @throws If an unexpected HTTP error occured.
   */
  async #reserveUploadAndCommitTarball(
    script: ScriptReference,
    fingerprint: Fingerprint,
    tarballPath: string
  ): Promise<boolean> {
    const tarballStats = await fs.stat(tarballPath);
    const tarballBytes = tarballStats.size;
    // Reference:
    // https://github.com/actions/toolkit/blob/f8a69bc473af4a204d0c03de61d5c9d1300dfb17/packages/cache/src/cache.ts#L174
    const GB = 1024 * 1024 * 1024;
    const maxBytes = 10 * GB;
    if (tarballBytes > maxBytes) {
      this.#logger.log({
        script,
        type: 'info',
        detail: 'generic',
        message:
          `Output was too big to be cached: ` +
          `${Math.round(tarballBytes / GB)}GB > ` +
          `${Math.round(maxBytes / GB)}GB.`,
      });
      return false;
    }
    const id = await this.#reserveCacheEntry(
      script,
      this.#computeCacheKey(script),
      this.#computeVersion(fingerprint),
      tarballBytes
    );
    // It's likely that we'll occasionally fail to reserve an entry and get
    // undefined here, especially when running multiple GitHub Action jobs in
    // parallel with the same scripts, because there is a window of time between
    // calling "get" and "set" on the cache in which another worker could have
    // reserved the entry before us. Non fatal, just don't save.
    if (id === undefined) {
      return false;
    }
    if (!(await this.#upload(script, id, tarballPath, tarballBytes))) {
      return false;
    }
    if (!(await this.#commit(script, id, tarballBytes))) {
      return false;
    }
    return true;
  }

  /**
   * @returns True if we uploaded, false if we gave up due to a rate limit error.
   * @throws If an unexpected HTTP error occured.
   */
  async #upload(
    script: ScriptReference,
    id: number,
    tarballPath: string,
    tarballBytes: number
  ): Promise<boolean> {
    const url = new URL(`_apis/artifactcache/caches/${id}`, this.#baseUrl);
    // Reference:
    // https://github.com/actions/toolkit/blob/500d0b42fee2552ae9eeb5933091fe2fbf14e72d/packages/cache/src/options.ts#L59
    const maxChunkSize = 32 * 1024 * 1024;
    const tarballHandle = await fs.open(tarballPath, 'r');
    let offset = 0;
    try {
      // TODO(aomarks) Chunks could be uploaded in parallel.
      while (offset < tarballBytes) {
        const chunkSize = Math.min(tarballBytes - offset, maxChunkSize);
        const start = offset;
        const end = offset + chunkSize - 1;
        offset += maxChunkSize;

        const tarballChunkStream = createReadStream(tarballPath, {
          fd: tarballHandle.fd,
          start,
          end,
          autoClose: false,
        });

        const opts = {
          method: 'PATCH',
          headers: {
            'content-type': 'application/octet-stream',
            'content-range': `bytes ${start}-${end}/*`,
          },
        };
        const {req, resPromise} = this.#request(url, opts);
        tarballChunkStream.pipe(req);
        tarballChunkStream.on('close', () => {
          req.end();
        });

        const res = await resPromise;

        if (res.statusCode === /* Too Many Requests */ 429) {
          this.#onRateLimit(script);
          return false;
        }

        if (!isOk(res)) {
          throw new Error(
            `GitHub Cache upload HTTP ${String(
              res.statusCode
            )} error: ${await readBody(res)}\nopts: ${JSON.stringify(opts)}`
          );
        }
      }
      return true;
    } finally {
      await tarballHandle.close();
    }
  }

  /**
   * @returns True if we committed, false if we gave up due to a rate limit error.
   * @throws If an unexpected HTTP error occured.
   */
  async #commit(
    script: ScriptReference,
    id: number,
    tarballBytes: number
  ): Promise<boolean> {
    const url = new URL(
      `_apis/artifactcache/caches/${String(id)}`,
      this.#baseUrl
    );
    const reqBody = JSON.stringify({
      size: tarballBytes,
    });
    const {req, resPromise} = this.#request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
    });
    req.end(reqBody);
    const res = await resPromise;

    if (res.statusCode === /* Too Many Requests */ 429) {
      this.#onRateLimit(script);
      return false;
    }

    if (!isOk(res)) {
      throw new Error(
        `GitHub Cache commit HTTP ${String(
          res.statusCode
        )} error: ${await readBody(res)}`
      );
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

  #computeVersion(fingerprint: Fingerprint): string {
    const parts: string[] = [
      fingerprint.string,
      'gzip', // e.g. zstd, gzip
      // The ImageOS environment variable tells us which operating system
      // version is being used for the worker VM (e.g. "ubuntu20",
      // "macos11"). We already include process.platform in the fingerprint,
      // but this is more specific.
      //
      // There is also an ImageVersion variable (e.g. "20220405.4") which we
      // could consider including, but it probably changes frequently and is
      // unlikely to affect output, so we prefer the higher cache hit rate.
      process.env.ImageOS ?? '',
      // Versioning salt:
      //   - <omitted>: Initial version.
      //   - 2: Removed empty directories manifest.
      '2',
    ];
    return createHash('sha256')
      .update(
        parts.join('\x1E') // ASCII record seperator
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
   * undefined if the cache entry was already reserved, or a rate limit error
   * occured.
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
  #script: ScriptReference;
  #url: string;
  #applied = false;

  constructor(script: ScriptReference, location: string) {
    this.#script = script;
    this.#url = location;
  }

  async apply(): Promise<void> {
    if (this.#applied) {
      throw new Error('GitHubActionsCacheHit.apply was called more than once');
    }
    this.#applied = true;
    const tempDir = await makeTempDir(this.#script);
    const tarballPath = pathlib.join(tempDir, 'cache.tgz');
    try {
      // TODO(aomarks) Recover from rate limits and other HTTP errors.
      await this.#download(tarballPath);
      await this.#extract(tarballPath);
    } finally {
      await fs.rm(tempDir, {recursive: true});
    }
  }

  async #download(tarballPath: string): Promise<void> {
    const {req, resPromise} = request(this.#url);
    req.end();
    const res = await resPromise;
    if (!isOk(res)) {
      throw new Error(
        `GitHub Cache download HTTP ${String(res.statusCode)} error`
      );
    }
    await new Promise<void>((resolve, reject) => {
      const writeTarballStream = createWriteStream(tarballPath);
      writeTarballStream.on('error', (error) => reject(error));
      res.on('error', (error) => reject(error));
      res.pipe(writeTarballStream);
      writeTarballStream.on('close', () => {
        resolve();
      });
    });
  }

  #extract(tarballPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      execFile(
        'tar',
        ['--extract', '--file', tarballPath, '--gzip', '-P'],
        (error: unknown) => {
          if (error != null) {
            reject(`tar error: ${String(error)}`);
          } else {
            resolve();
          }
        }
      );
    });
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
