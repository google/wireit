/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {execFile} from 'child_process';
import {createHash} from 'crypto';
import * as unbudgetedFs from 'fs/promises';
import * as https from 'https';
import * as pathlib from 'path';
import {inspect} from 'util';
import {scriptReferenceToString} from '../config.js';
import '../util/dispose.js';
import * as fs from '../util/fs.js';
import {fileBudget} from '../util/fs.js';
import {getScriptDataDir} from '../util/script-data-dir.js';

import type * as http from 'http';
import type {ScriptReference} from '../config.js';
import type {Result} from '../error.js';
import type {InvalidUsage, UnknownErrorThrown} from '../event.js';
import type {Fingerprint} from '../fingerprint.js';
import type {Logger} from '../logging/logger.js';
import type {AbsoluteEntry} from '../util/glob.js';
import type {Cache, CacheHit} from './cache.js';

/**
 * Caches script output to the GitHub Actions caching service.
 */
export class GitHubActionsCache implements Cache {
  readonly #baseUrl: string;
  readonly #authToken: string;
  readonly #logger: Logger;

  /**
   * Once we've hit a rate limit or service availability error, simply stop
   * hitting the cache for the remainder of this Wireit process. Caching is not
   * critical, it's just an optimization.
   *
   * TODO(aomarks) We could be a little smarter and do retries, but this at
   * least should stop builds breaking in the short-term.
   */
  #serviceIsDown = false;

  private constructor(logger: Logger, baseUrl: string, authToken: string) {
    this.#baseUrl = baseUrl;
    this.#authToken = authToken;
    this.#logger = logger;
  }

  static async create(
    logger: Logger,
  ): Promise<
    Result<
      GitHubActionsCache,
      Omit<InvalidUsage, 'script'> | Omit<UnknownErrorThrown, 'script'>
    >
  > {
    const custodianPort = process.env['WIREIT_CACHE_GITHUB_CUSTODIAN_PORT'];
    if (custodianPort === undefined) {
      if (
        process.env['ACTIONS_RUNTIME_TOKEN'] !== undefined ||
        process.env['ACTIONS_CACHE_URL'] !== undefined
      ) {
        console.warn(
          '⚠️ Please upgrade to google/wireit@setup-github-cache/v2. ' +
            'In the future, Wireit caching for this project will stop working.\n',
        );
        return GitHubActionsCache.#deprecatedCreate(logger);
      }
      return {
        ok: false,
        error: {
          type: 'failure',
          reason: 'invalid-usage',
          message:
            'The WIREIT_CACHE_GITHUB_CUSTODIAN_PORT environment variable was ' +
            'not set, but is required when WIREIT_CACHE=github. Use the ' +
            'google/wireit@setup-github-cache/v2 action to automatically set ' +
            'this environment variable.',
        },
      };
    }
    const custodianUrl = `http://localhost:${custodianPort}`;
    let result: {
      caching: {
        github: {
          ACTIONS_RESULTS_URL: string;
          ACTIONS_RUNTIME_TOKEN: string;
        };
      };
    };
    try {
      const response = await fetch(custodianUrl);
      if (!response.ok) {
        throw new Error(`HTTP status ${response.status}`);
      }
      result = (await response.json()) as typeof result;
    } catch (error) {
      return {
        ok: false,
        error: {
          type: 'failure',
          reason: 'unknown-error-thrown',
          error: new Error(
            `Error communicating with cache token mediator service: ` +
              inspect(error),
          ),
        },
      };
    }
    return {
      ok: true,
      value: new GitHubActionsCache(
        logger,
        result.caching.github.ACTIONS_RESULTS_URL,
        result.caching.github.ACTIONS_RUNTIME_TOKEN,
      ),
    };
  }

  static #deprecatedCreate(
    logger: Logger,
  ): Result<GitHubActionsCache, Omit<InvalidUsage, 'script'>> {
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
          type: 'failure',
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
          type: 'failure',
          reason: 'invalid-usage',
          message: `The ACTIONS_CACHE_URL must end in a forward-slash, got ${JSON.stringify(
            baseUrl,
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
          type: 'failure',
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
    fingerprint: Fingerprint,
  ): Promise<CacheHit | undefined> {
    if (this.#serviceIsDown) {
      return undefined;
    }

    const version = this.#computeVersion(fingerprint);
    const key = this.#computeCacheKey(script);
    const url = new URL(
      // See https://github.com/actions/toolkit/blob/930c89072712a3aac52d74b23338f00bb0cfcb24/packages/cache/src/generated/results/api/v1/cache.twirp-client.ts#L91
      'twirp/github.actions.results.api.v1.CacheService/GetCacheEntryDownloadURL',
      this.#baseUrl,
    );
    // See https://github.com/actions/toolkit/blob/930c89072712a3aac52d74b23338f00bb0cfcb24/packages/cache/src/cache.ts#L246
    // and https://github.com/actions/toolkit/blob/930c89072712a3aac52d74b23338f00bb0cfcb24/packages/cache/src/generated/results/api/v1/cache.ts#L101C1-L126C2
    const requestBody = {key, version};
    const bodyBuffer = Buffer.from(JSON.stringify(requestBody), 'utf8');
    using requestResult = this.#request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': bodyBuffer.length,
      },
    });
    const {req, resPromise} = requestResult;
    req.end(bodyBuffer);
    const result = await resPromise;
    if (!this.#maybeHandleServiceDown(result, script)) {
      return undefined;
    }
    const response = result.value;

    if (isOk(response)) {
      const responseBody = await readBody(response);
      console.log('PROBE get', {
        url,
        requestBody,
        responseBody,
        status: response.statusCode,
      });
      // console.log({body});
      const {signed_download_url: archiveLocation} = JSON.parse(
        responseBody,
      ) as {
        ok: boolean;
        signed_download_url: string;
        matched_key: string;
      };
      if (!archiveLocation) {
        return undefined;
      }
      return new GitHubActionsCacheHit(script, archiveLocation, this.#logger);
    }

    throw new Error(
      `GitHub Cache check HTTP ${String(response.statusCode)} error ${url}: ` +
        (await readBody(response)),
    );
  }

  async set(
    script: ScriptReference,
    fingerprint: Fingerprint,
    absFiles: AbsoluteEntry[],
  ): Promise<boolean> {
    if (this.#serviceIsDown) {
      return false;
    }

    await using tempDir = await makeTempDir(script);
    const tarballPath = await this.#makeTarball(
      absFiles.map((file) => file.path),
      tempDir.path,
    );
    return await this.#reserveUploadAndCommitTarball(
      script,
      fingerprint,
      tarballPath,
    );
  }

  /**
   * @returns True if we reserved, uploaded, and committed the tarball. False if
   * we gave up due to a rate limit error.
   * @throws If an unexpected HTTP error occured.
   */
  async #reserveUploadAndCommitTarball(
    script: ScriptReference,
    fingerprint: Fingerprint,
    tarballPath: string,
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
        detail: 'cache-info',
        message:
          `Output was too big to be cached: ` +
          `${Math.round(tarballBytes / GB)}GB > ` +
          `${Math.round(maxBytes / GB)}GB.`,
      });
      return false;
    }
    const key = this.#computeCacheKey(script);
    const version = this.#computeVersion(fingerprint);
    const uploadUrl = await this.#reserveCacheEntry(
      script,
      key,
      version,
      tarballBytes,
    );
    console.log('TRYING AGAINN');
    const uploadUrl2 = await this.#reserveCacheEntry(
      script,
      key,
      version,
      tarballBytes,
    );
    console.log({uploadUrl2});
    // It's likely that we'll occasionally fail to reserve an entry and get
    // undefined here, especially when running multiple GitHub Action jobs in
    // parallel with the same scripts, because there is a window of time between
    // calling "get" and "set" on the cache in which another worker could have
    // reserved the entry before us. Non fatal, just don't save.
    if (uploadUrl === undefined) {
      return false;
    }
    if (!(await this.#upload(script, uploadUrl, tarballPath, tarballBytes))) {
      return false;
    }
    if (!(await this.#commit(script, key, version, tarballBytes))) {
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
    uploadUrl: string,
    tarballPath: string,
    tarballBytes: number,
  ): Promise<boolean> {
    // Reference:
    // https://learn.microsoft.com/en-us/rest/api/storageservices/append-block?tabs=microsoft-entra-id#remarks
    const maxChunkSize = 32 * 1024 * 1024;
    // TODO: update to TypeScript 5.2 and use the new `using` syntax for the
    // budget object.
    const reservation = await fileBudget.reserve();
    const tarballHandle = await unbudgetedFs.open(tarballPath, 'r');
    let offset = 0;
    try {
      // See https://github.com/actions/toolkit/blob/930c89072712a3aac52d74b23338f00bb0cfcb24/packages/cache/src/internal/uploadUtils.ts#L132
      // TODO(aomarks) Chunks could be uploaded in parallel.
      const blockIds: string[] = [];
      let blockIdx = 0;
      while (offset < tarballBytes) {
        const chunkSize = Math.min(tarballBytes - offset, maxChunkSize);
        const start = offset;
        const end = offset + chunkSize - 1;
        offset += maxChunkSize;

        const tarballChunkStream = await fs.createReadStream(tarballPath, {
          fd: tarballHandle.fd,
          start,
          end,
          autoClose: false,
        });

        const opts = {
          method: 'PUT',
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': `${chunkSize}`,
            'x-ms-blob-type': 'BlockBlob',
            authorization: undefined,
          },
        };
        const chunkUrl = new URL(uploadUrl);
        chunkUrl.searchParams.set('comp', 'block');
        // All block IDs must be the same length within a blob.
        const blockId = Buffer.from(
          blockIdx.toString(16).padStart(4, '0'),
        ).toString('base64');
        blockIdx++;
        blockIds.push(blockId);
        chunkUrl.searchParams.set('blockid', blockId);
        using requestResult = this.#request(chunkUrl, opts);
        const {req, resPromise} = requestResult;
        tarballChunkStream.pipe(req);
        tarballChunkStream.on('close', () => {
          req.end();
        });

        const result = await resPromise;
        if (!this.#maybeHandleServiceDown(result, script)) {
          return false;
        }
        const response = result.value;
        console.log('PROBE UPLOAD BLOCK', {
          chunkUrl,
          opts,
          status: response.statusCode,
          responseBody: await readBody(response),
        });

        if (!isOk(response)) {
          throw new Error(
            `GitHub Cache upload HTTP ${String(
              response.statusCode,
            )} error: ${await readBody(response)}\nopts: ${JSON.stringify(
              opts,
            )}`,
          );
        }
      }
      const doneUrl = new URL(uploadUrl);
      doneUrl.searchParams.set('comp', 'blocklist');
      const doneXmlBody = Buffer.from(
        `<?xml version="1.0" encoding="utf-8"?>
<BlockList>
${blockIds.map((blockId) => `  <Uncommitted>${blockId}</Uncommitted>`).join('\n')}
</BlockList>
`,
        'utf8',
      );
      using requestResult = this.#request(doneUrl, {
        method: 'PUT',
        headers: {
          'content-type': 'text/plain; charset=UTF-8',
          'content-length': `${doneXmlBody.length}`,
          authorization: undefined,
        },
      });
      requestResult.req.end(doneXmlBody);
      const r = await requestResult.resPromise;
      if (!this.#maybeHandleServiceDown(r, script)) {
        return false;
      }
      let responseData = '';
      r.value.on('data', (chunk: string) => (responseData += chunk));
      await new Promise((resolve) => r.value.on('end', resolve));
      console.log('PROBE FINALIZE BLOB', {
        doneUrl,
        status: r.value.statusCode,
        responseData,
      });
      return true;
    } finally {
      await tarballHandle.close();
      reservation[Symbol.dispose]();
    }
  }

  /**
   * @returns True if we committed, false if we gave up due to a rate limit error.
   * @throws If an unexpected HTTP error occured.
   */
  async #commit(
    script: ScriptReference,
    key: string,
    version: string,
    tarballBytes: number,
  ): Promise<boolean> {
    const url = new URL(
      // See
      // https://github.com/actions/toolkit/blob/930c89072712a3aac52d74b23338f00bb0cfcb24/packages/cache/src/generated/results/api/v1/cache.twirp-client.ts#L132
      `twirp/github.actions.results.api.v1.CacheService/FinalizeCacheEntryUpload`,
      this.#baseUrl,
    );
    // See
    // https://github.com/actions/toolkit/blob/930c89072712a3aac52d74b23338f00bb0cfcb24/packages/cache/src/cache.ts#L555
    // and https://github.com/actions/toolkit/blob/930c89072712a3aac52d74b23338f00bb0cfcb24/packages/cache/src/generated/results/api/v1/cache.ts#L57
    const body = {
      key,
      version,
      sizeBytes: tarballBytes,
    };
    const bodyBuffer = Buffer.from(JSON.stringify(body), 'utf8');
    using requestResult = this.#request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': bodyBuffer.length,
      },
    });
    const {req, resPromise} = requestResult;
    req.end(bodyBuffer);

    const result = await resPromise;
    if (!this.#maybeHandleServiceDown(result, script)) {
      return false;
    }
    const response = result.value;

    if (!isOk(response)) {
      throw new Error(
        `GitHub Cache commit HTTP ${String(
          response.statusCode,
        )} error: ${await readBody(response)}`,
      );
    }

    console.log('PROBE FINALIZE ENTRY', {
      url,
      status: response.statusCode,
      responseBody: await readBody(response),
    });

    return true;
  }

  #request(
    url: URL,
    options?: http.RequestOptions,
  ): {
    req: http.ClientRequest;
    resPromise: Promise<Result<http.IncomingMessage, Error>>;
  } & Disposable {
    return request(url, {
      ...options,
      headers: {
        accept: 'application/json',
        // https://github.com/actions/toolkit/blob/500d0b42fee2552ae9eeb5933091fe2fbf14e72d/packages/http-client/src/auth.ts#L46
        authorization: `Bearer ${this.#authToken}`,
        ...options?.headers,
      },
    });
  }

  /**
   * If we received an error that indicates something is wrong with the GitHub
   * Actions service that is not our fault, log an error and return false.
   * Otherwise return true.
   */
  #maybeHandleServiceDown(
    res: Result<http.IncomingMessage, Error>,
    script: ScriptReference,
  ): res is {ok: true; value: http.IncomingMessage} {
    if (!res.ok) {
      if (!this.#serviceIsDown) {
        this.#logger.log({
          script,
          type: 'info',
          detail: 'cache-info',
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
          if (!this.#serviceIsDown) {
            this.#logger.log({
              script,
              type: 'info',
              detail: 'cache-info',
              message: `Hit GitHub Actions cache rate limit, caching disabled.`,
            });
          }
          break;
        }
        case /* Service Unavailable */ 503: {
          if (!this.#serviceIsDown) {
            this.#logger.log({
              script,
              type: 'info',
              detail: 'cache-info',
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
    this.#serviceIsDown = true;
    return false;
  }

  #computeCacheKey(script: ScriptReference): string {
    return `TEST_wireit-${createHash('sha256')
      .update(scriptReferenceToString(script))
      .digest('hex')}`;
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
        parts.join('\x1E'), // ASCII record seperator
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
            reject(new Error(`tar error: ${String(error as Error)}`));
          } else {
            resolve();
          }
        },
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
    _cacheSize: number,
  ): Promise<string | undefined> {
    const url = new URL(
      // See https://github.com/actions/toolkit/blob/930c89072712a3aac52d74b23338f00bb0cfcb24/packages/cache/src/generated/results/api/v1/cache.twirp-client.ts#L117
      'twirp/github.actions.results.api.v1.CacheService/CreateCacheEntry',
      this.#baseUrl,
    );
    // See
    // https://github.com/actions/toolkit/blob/930c89072712a3aac52d74b23338f00bb0cfcb24/packages/cache/src/cache.ts#L527
    // and https://github.com/actions/toolkit/blob/930c89072712a3aac52d74b23338f00bb0cfcb24/packages/cache/src/generated/results/api/v1/cache.ts#L19
    const body = {
      key,
      version,
    };
    const bodyBuffer = Buffer.from(JSON.stringify(body), 'utf8');
    using requestResult = this.#request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': bodyBuffer.length,
      },
    });
    const {req, resPromise} = requestResult;
    req.end(bodyBuffer);

    const result = await resPromise;
    if (!this.#maybeHandleServiceDown(result, script)) {
      return undefined;
    }
    const response = result.value;

    if (isOk(response)) {
      const responseBody = await readBody(response);
      console.log('PROBE reserve', {
        url,
        body,
        responseBody,
        status: response.statusCode,
      });
      const resData = JSON.parse(responseBody) as {
        signed_upload_url: string;
      };
      return resData.signed_upload_url;
    }

    if (response.statusCode === /* Conflict */ 409) {
      // TODO(aomarks) How are conflicts returned in the v2 API?
      return undefined;
    }

    throw new Error(
      `GitHub Cache reserve HTTP ${String(
        response.statusCode,
      )} error: ${await readBody(response)}`,
    );
  }
}

class GitHubActionsCacheHit implements CacheHit {
  readonly #script: ScriptReference;
  readonly #url: string;
  readonly #logger: Logger;
  #applied = false;

  constructor(script: ScriptReference, location: string, logger: Logger) {
    this.#script = script;
    this.#url = location;
    this.#logger = logger;
  }

  async apply(): Promise<void> {
    if (this.#applied) {
      throw new Error('GitHubActionsCacheHit.apply was called more than once');
    }
    this.#applied = true;
    await using tempDir = await makeTempDir(this.#script);
    const tarballPath = pathlib.join(tempDir.path, 'cache.tgz');
    try {
      await this.#download(tarballPath);
    } catch (e: unknown) {
      this.#logger.log({
        type: 'info',
        detail: 'cache-info',
        script: this.#script,
        message: `Failed to download GitHub Actions cache tarball: ${
          (e as Partial<Error>)?.message ?? String(e)
        }`,
      });
      // This is fine, it's as though there was nothing to restore from
      // the cache.
      return;
    }
    await this.#extract(tarballPath);
  }

  async #download(tarballPath: string): Promise<void> {
    using requestResult = request(this.#url);
    const {req, resPromise} = requestResult;
    req.end();
    const result = await resPromise;
    if (!result.ok) {
      throw new Error(`GitHub Cache download TCP error`);
    }
    const response = result.value;
    if (!isOk(response)) {
      throw new Error(
        `GitHub Cache download HTTP ${String(response.statusCode)} error`,
      );
    }
    const writeTarballStream = await fs.createWriteStream(tarballPath);
    await new Promise<void>((resolve, reject) => {
      writeTarballStream.on('error', (error) => reject(error));
      response.on('error', (error) => reject(error));
      response.pipe(writeTarballStream);
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
            reject(new Error(`tar error: ${String(error as Error)}`));
          } else {
            resolve();
          }
        },
      );
    });
  }
}

function request(
  url: URL | string,
  options?: http.RequestOptions,
): {
  req: http.ClientRequest;
  resPromise: Promise<Result<http.IncomingMessage, Error>>;
} & Disposable {
  const opts = {
    ...options,
    headers: {
      // https://github.com/actions/toolkit/blob/500d0b42fee2552ae9eeb5933091fe2fbf14e72d/packages/cache/src/internal/cacheHttpClient.ts#L67
      'user-agent': 'actions/cache',
      ...options?.headers,
    },
  };
  for (const [key, val] of Object.entries(opts.headers)) {
    if (!val) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (opts.headers as Record<string, unknown>)[key];
    }
  }
  let req!: http.ClientRequest;
  const resPromise = new Promise<Result<http.IncomingMessage, Error>>(
    (resolve) => {
      // console.log('REQUEST', {url, opts});
      req = https.request(url, opts, (value) => {
        resolve({ok: true, value});
      });
      req.on('error', (error) => {
        resolve({ok: false, error});
      });
      req.on('socket', (socket) => {
        socket.on('error', () => {
          resolve({ok: false, error: new Error('socket error')});
        });
        socket.on('close', (hadError) => {
          if (hadError) {
            resolve({ok: false, error: new Error('socket closed with error')});
          }
        });
      });
    },
  );
  return {
    req,
    resPromise,
    [Symbol.dispose]() {
      req.destroy();
      req.socket?.destroy();
    },
  };
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
    res.socket.on('error', () => {
      reject(new Error('socket error'));
    });
    res.socket.on('close', (hadError) => {
      if (hadError) {
        reject(new Error('socket closed with error'));
      }
    });
    res.on('end', () => {
      resolve(Buffer.concat(chunks).toString());
    });
  });
}

async function makeTempDir(
  script: ScriptReference,
): Promise<{path: string} & AsyncDisposable> {
  const prefix = pathlib.join(getScriptDataDir(script), 'temp');
  await fs.mkdir(prefix, {recursive: true});
  const path = await fs.mkdtemp(prefix);
  return {
    path,
    async [Symbol.asyncDispose]() {
      await fs.rm(path, {recursive: true});
    },
  };
}
