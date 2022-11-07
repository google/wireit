/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import * as fs from 'fs/promises';
import * as https from 'https';
import {createHash} from 'crypto';
import {scriptReferenceToString} from '../config.js';
import {getScriptDataDir} from '../util/script-data-dir.js';
import {execFile} from 'child_process';
import {createReadStream, createWriteStream} from 'fs';

import type * as http from 'http';
import type {Cache, CacheHit} from './cache.js';
import type {ScriptReference} from '../config.js';
import type {Fingerprint} from '../fingerprint.js';
import type {Logger} from '../logging/logger.js';
import type {AbsoluteEntry} from '../util/glob.js';
import type {Result} from '../error.js';

/**
 * Caches script output to the GitHub Actions caching service.
 */
export class GitHubActionsCache implements Cache {
  private readonly _baseUrl: string;
  private readonly _authToken: string;
  private readonly _logger: Logger;

  /**
   * Once we've hit a rate limit or service availability error, simply stop
   * hitting the cache for the remainder of this Wireit process. Caching is not
   * critical, it's just an optimization.
   *
   * TODO(aomarks) We could be a little smarter and do retries, but this at
   * least should stop builds breaking in the short-term.
   */
  private _serviceIsDown = false;

  private constructor(logger: Logger, baseUrl: string, authToken: string) {
    this._baseUrl = baseUrl;
    this._authToken = authToken;
    this._logger = logger;
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
    if (this._serviceIsDown) {
      return undefined;
    }

    const version = this._computeVersion(fingerprint);
    const key = this._computeCacheKey(script);
    const url = new URL('_apis/artifactcache/cache', this._baseUrl);
    url.searchParams.set('keys', key);
    url.searchParams.set('version', version);

    const {req, resPromise} = this._request(url);
    req.end();
    const result = await resPromise;
    if (!this._maybeHandleServiceDown(result, script)) {
      return undefined;
    }
    const response = result.value;

    if (response.statusCode === /* No Content */ 204) {
      return undefined;
    }

    if (isOk(response)) {
      const {archiveLocation} = JSON.parse(await readBody(response)) as {
        archiveLocation: string;
      };
      return new GitHubActionsCacheHit(script, archiveLocation);
    }

    throw new Error(
      `GitHub Cache check HTTP ${String(response.statusCode)} error: ` +
        (await readBody(response))
    );
  }

  async set(
    script: ScriptReference,
    fingerprint: Fingerprint,
    absFiles: AbsoluteEntry[]
  ): Promise<boolean> {
    if (this._serviceIsDown) {
      return false;
    }

    const tempDir = await makeTempDir(script);
    try {
      const tarballPath = await this._makeTarball(
        absFiles.map((file) => file.path),
        tempDir
      );
      return await this._reserveUploadAndCommitTarball(
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
  private async _reserveUploadAndCommitTarball(
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
      this._logger.log({
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
    const id = await this._reserveCacheEntry(
      script,
      this._computeCacheKey(script),
      this._computeVersion(fingerprint),
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
    if (!(await this._upload(script, id, tarballPath, tarballBytes))) {
      return false;
    }
    if (!(await this._commit(script, id, tarballBytes))) {
      return false;
    }
    return true;
  }

  /**
   * @returns True if we uploaded, false if we gave up due to a rate limit error.
   * @throws If an unexpected HTTP error occured.
   */
  private async _upload(
    script: ScriptReference,
    id: number,
    tarballPath: string,
    tarballBytes: number
  ): Promise<boolean> {
    const url = new URL(`_apis/artifactcache/caches/${id}`, this._baseUrl);
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
        const {req, resPromise} = this._request(url, opts);
        tarballChunkStream.pipe(req);
        tarballChunkStream.on('close', () => {
          req.end();
        });

        const result = await resPromise;
        if (!this._maybeHandleServiceDown(result, script)) {
          return false;
        }
        const response = result.value;

        if (!isOk(response)) {
          throw new Error(
            `GitHub Cache upload HTTP ${String(
              response.statusCode
            )} error: ${await readBody(response)}\nopts: ${JSON.stringify(
              opts
            )}`
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
  private async _commit(
    script: ScriptReference,
    id: number,
    tarballBytes: number
  ): Promise<boolean> {
    const url = new URL(
      `_apis/artifactcache/caches/${String(id)}`,
      this._baseUrl
    );
    const reqBody = JSON.stringify({
      size: tarballBytes,
    });
    const {req, resPromise} = this._request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
    });
    req.end(reqBody);

    const result = await resPromise;
    if (!this._maybeHandleServiceDown(result, script)) {
      return false;
    }
    const response = result.value;

    if (!isOk(response)) {
      throw new Error(
        `GitHub Cache commit HTTP ${String(
          response.statusCode
        )} error: ${await readBody(response)}`
      );
    }

    return true;
  }

  private _request(
    url: URL,
    options?: http.RequestOptions
  ): {
    req: http.ClientRequest;
    resPromise: Promise<Result<http.IncomingMessage, Error>>;
  } {
    return request(url, {
      ...options,
      headers: {
        // https://github.com/actions/toolkit/blob/500d0b42fee2552ae9eeb5933091fe2fbf14e72d/packages/cache/src/internal/cacheHttpClient.ts#L55
        accept: 'application/json;api-version=6.0-preview.1',
        // https://github.com/actions/toolkit/blob/500d0b42fee2552ae9eeb5933091fe2fbf14e72d/packages/http-client/src/auth.ts#L46
        authorization: `Bearer ${this._authToken}`,
        ...options?.headers,
      },
    });
  }

  /**
   * If we received an error that indicates something is wrong with the GitHub
   * Actions service that is not our fault, log an error and return false.
   * Otherwise return true.
   */
  private _maybeHandleServiceDown(
    res: Result<http.IncomingMessage, Error>,
    script: ScriptReference
  ): res is {ok: true; value: http.IncomingMessage} {
    if (!res.ok) {
      if (!this._serviceIsDown) {
        this._logger.log({
          script,
          type: 'info',
          detail: 'generic',
          message:
            `Connection error from GitHub Actions service, caching disabled. ` +
            'Detail: ' +
            ('code' in res.error
              ? `${(res.error as Error & {code: string}).code} `
              : '') +
            res.error.message,
        });
      }
    } else {
      switch (res.value.statusCode) {
        case /* Too Many Requests */ 429: {
          if (!this._serviceIsDown) {
            this._logger.log({
              script,
              type: 'info',
              detail: 'generic',
              message: `Hit GitHub Actions cache rate limit, caching disabled.`,
            });
          }
          break;
        }
        case /* Service Unavailable */ 503: {
          if (!this._serviceIsDown) {
            this._logger.log({
              script,
              type: 'info',
              detail: 'generic',
              message: `GitHub Actions service is unavailable, caching disabled.`,
            });
          }
          break;
        }
        default: {
          return true;
        }
      }
    }
    this._serviceIsDown = true;
    return false;
  }

  private _computeCacheKey(script: ScriptReference): string {
    return createHash('sha256')
      .update(scriptReferenceToString(script))
      .digest('hex');
  }

  private _computeVersion(fingerprint: Fingerprint): string {
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
  private async _makeTarball(
    paths: string[],
    tempDir: string
  ): Promise<string> {
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
  private async _reserveCacheEntry(
    script: ScriptReference,
    key: string,
    version: string,
    cacheSize: number
  ): Promise<number | undefined> {
    const url = new URL('_apis/artifactcache/caches', this._baseUrl);
    const reqBody = JSON.stringify({
      key,
      version,
      cacheSize,
    });
    const {req, resPromise} = this._request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
    });
    req.end(reqBody);

    const result = await resPromise;
    if (!this._maybeHandleServiceDown(result, script)) {
      return undefined;
    }
    const response = result.value;

    if (isOk(response)) {
      const resData = JSON.parse(await readBody(response)) as {
        cacheId: number;
      };
      return resData.cacheId;
    }

    if (response.statusCode === /* Conflict */ 409) {
      return undefined;
    }

    throw new Error(
      `GitHub Cache reserve HTTP ${String(
        response.statusCode
      )} error: ${await readBody(response)}`
    );
  }
}

class GitHubActionsCacheHit implements CacheHit {
  private _script: ScriptReference;
  private _url: string;
  private _applied = false;

  constructor(script: ScriptReference, location: string) {
    this._script = script;
    this._url = location;
  }

  async apply(): Promise<void> {
    if (this._applied) {
      throw new Error('GitHubActionsCacheHit.apply was called more than once');
    }
    this._applied = true;
    const tempDir = await makeTempDir(this._script);
    const tarballPath = pathlib.join(tempDir, 'cache.tgz');
    try {
      // TODO(aomarks) Recover from rate limits and other HTTP errors.
      await this._download(tarballPath);
      await this._extract(tarballPath);
    } finally {
      await fs.rm(tempDir, {recursive: true});
    }
  }

  private async _download(tarballPath: string): Promise<void> {
    const {req, resPromise} = request(this._url);
    req.end();
    const result = await resPromise;
    if (!result.ok) {
      throw new Error(`GitHub Cache download TCP error`);
    }
    const response = result.value;
    if (!isOk(response)) {
      throw new Error(
        `GitHub Cache download HTTP ${String(response.statusCode)} error`
      );
    }
    await new Promise<void>((resolve, reject) => {
      const writeTarballStream = createWriteStream(tarballPath);
      writeTarballStream.on('error', (error) => reject(error));
      response.on('error', (error) => reject(error));
      response.pipe(writeTarballStream);
      writeTarballStream.on('close', () => {
        resolve();
      });
    });
  }

  private _extract(tarballPath: string): Promise<void> {
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
  resPromise: Promise<Result<http.IncomingMessage, Error>>;
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
  const resPromise = new Promise<Result<http.IncomingMessage, Error>>(
    (resolve) => {
      req = https.request(url, opts, (value) => {
        resolve({ok: true, value});
      });
      req.on('error', (error) => {
        resolve({ok: false, error});
      });
    }
  );
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
