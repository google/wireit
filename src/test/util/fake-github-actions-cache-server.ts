/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as http from 'http';
import * as https from 'https';

/**
 * String ID for a cache entry.
 */
type EntryId = string & {
  __EntryIdBrand__: never;
};

/**
 * Random ID for a tarball on the CDN.
 */
type TarballId = string & {
  __TarballIdBrand__: never;
};

/**
 * Cache key + version as a compound string (only used internally to this fake
 * as a Map key).
 */
type KeyAndVersion = string & {
  __KeyAndVersionBrand__: never;
};

interface CacheEntry {
  chunks: Map<string, Buffer>;
  commited: boolean;
  tarballId: TarballId;
}

const encodeKeyAndVersion = (key: string, version: string): KeyAndVersion =>
  `${key}:${version}` as KeyAndVersion;

type ApiName = 'check' | 'reserve' | 'upload' | 'commit' | 'download';

const JSON_RESPONSE_TYPE = 'application/json';

/**
 * A fake version of the GitHub Actions cache server.
 *
 * These APIs are not formally documented. This implementation was designed by
 * looking at the behavior of the GitHub Actions caching client library at
 * https://github.com/actions/toolkit/tree/main/packages/cache, and through live
 * testing.
 *
 * The expected usage lifecycle for these APIs are:
 *
 * - Client generates a key+version.
 *
 * - Client asks server to check if a cache entry exists for the given
 *   key+version.
 *   - If exists:
 *     - Server returns a URL of a tarball at a CDN.
 *     - Client downloads tarball and unpacks it.
 *     - <STOP>
 *   - If not exists:
 *     - Server returns "204 No Content" status.
 *
 * - Client asks server to reserve a cache entry for a given key+version.
 *   - If entry was already reserved:
 *     - Server returns a "409 Conflict" status.
 *     - <STOP>
 *   - If not already exists:
 *     - Server returns a new unique numeric cache entry ID.
 *
 * - Client sends 1 or more "upload" requests to endpoint containing chunks of
 *   the tarball.
 *
 * - Client sends "commit" request to indicate that all tarball chunks have been
 *   sent.
 */
export class FakeGitHubActionsCacheServer {
  readonly #server: http.Server;
  #url!: URL;

  /**
   * An authentication token which this server will require to be set in a
   * "Authorization: Bearer <token>" header.
   */
  readonly #authToken;

  /**
   * Counters for how many times each endpoint was hit in the lifetime of this
   * fake instance.
   */
  metrics!: {
    check: number;
    reserve: number;
    upload: number;
    commit: number;
    download: number;
  };

  #nextEntryId = 0;
  #forcedErrors = new Map<ApiName, number | 'ECONNRESET'>();
  readonly #entryIdToEntry = new Map<EntryId, CacheEntry>();
  readonly #keyAndVersionToEntryId = new Map<KeyAndVersion, EntryId>();
  readonly #tarballIdToEntryId = new Map<TarballId, EntryId>();

  constructor(authToken: string, tlsCert: {cert: string; key: string}) {
    this.#authToken = authToken;
    this.#server = https.createServer(tlsCert, this.#route);
    this.resetMetrics();
  }

  resetMetrics(): void {
    this.metrics = {
      check: 0,
      reserve: 0,
      upload: 0,
      commit: 0,
      download: 0,
    };
  }

  async listen(): Promise<string> {
    const host = 'localhost';
    await new Promise<void>((resolve) => {
      this.#server.listen({host, port: /* random free */ 0}, () => resolve());
    });
    const address = this.#server.address();
    if (address === null || typeof address !== 'object') {
      throw new Error(
        `Expected server address to be ServerInfo object, ` +
          `got ${JSON.stringify(address)}`,
      );
    }
    // The real API includes a unique identifier as the base path. It's good to
    // include this in the fake because it ensures the client is preserving the
    // base path and not just using the origin.
    const randomBasePath = Math.random().toString().slice(2);
    this.#url = new URL(`https://${host}:${address.port}/${randomBasePath}/`);
    return this.#url.href;
  }

  async close(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }

  forceErrorOnNextRequest(apiName: ApiName, code: number | 'ECONNRESET'): void {
    this.#forcedErrors.set(apiName, code);
  }

  #readBody(request: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    return new Promise((resolve) => {
      request.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
    });
  }

  #respond(
    response: http.ServerResponse,
    status: number,
    message?: string,
  ): void {
    response.statusCode = status;
    if (message !== undefined) {
      response.write(message);
    }
    response.end();
  }

  #maybeServeForcedError(
    response: http.ServerResponse,
    apiName: ApiName,
  ): boolean {
    const code = this.#forcedErrors.get(apiName);
    if (code !== undefined) {
      this.#forcedErrors.delete(apiName);
      if (code === 'ECONNRESET') {
        response.destroy();
      } else {
        this.#respond(response, code, `Forcing ${code} error for ${apiName}`);
      }
      return true;
    }
    return false;
  }

  #checkAuthorization(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): boolean {
    if (request.headers.authorization !== `Bearer ${this.#authToken}`) {
      this.#respond(response, /* Not Authorized */ 401);
      return false;
    }
    return true;
  }

  #checkUserAgent(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): boolean {
    return this.#checkHeader(
      request,
      response,
      'user-agent',
      // https://github.com/actions/toolkit/blob/500d0b42fee2552ae9eeb5933091fe2fbf14e72d/packages/cache/src/internal/cacheHttpClient.ts#L67
      'actions/cache',
    );
  }

  #checkContentType(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    expected: string | undefined,
  ): boolean {
    return this.#checkHeader(request, response, 'content-type', expected);
  }

  #checkAccept(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    expected: string | undefined,
  ): boolean {
    return this.#checkHeader(request, response, 'accept', expected);
  }

  #checkHeader(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    header: string,
    expected: string | undefined,
  ): boolean {
    const actual = request.headers[header];
    if (actual !== expected) {
      this.#respond(
        response,
        /* Bad Request */ 400,
        `Expected ${header} ${JSON.stringify(expected)}. ` +
          `Got ${JSON.stringify(actual)}.`,
      );
      return false;
    }
    return true;
  }

  #route = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): void => {
    if (!request.url) {
      return this.#respond(response, 404);
    }
    // request.url is a string with pathname + query params.
    const url = new URL(request.url, this.#url.origin);
    if (!url.pathname.startsWith(this.#url.pathname)) {
      // Missing the random base path.
      return this.#respond(response, 404);
    }
    const api = url.pathname.slice(this.#url.pathname.length);

    if (!this.#checkUserAgent(request, response)) {
      return;
    }

    console.log('SERVER', {api});
    if (
      api ===
        'twirp/github.actions.results.api.v1.CacheService/GetCacheEntryDownloadURL' &&
      request.method === 'POST'
    ) {
      return void this.#check(request, response);
    }

    if (
      api ===
        'twirp/github.actions.results.api.v1.CacheService/CreateCacheEntry' &&
      request.method === 'POST'
    ) {
      return void this.#reserve(request, response);
    }

    if (api === 'blobs' && request.method === 'PUT') {
      return void this.#upload(request, response, url);
    }

    if (
      api ===
        'twirp/github.actions.results.api.v1.CacheService/FinalizeCacheEntryUpload' &&
      request.method === 'POST'
    ) {
      return void this.#commit(request, response);
    }

    if (api.startsWith('tarballs/') && request.method === 'GET') {
      const tail = api.slice('tarballs/'.length);
      return this.#download(request, response, tail);
    }

    this.#respond(response, 404);
  };

  /**
   * Handle the GET:/_apis/artifactcache/cache API.
   *
   * This API checks if a (committed) cache entry exists for the given key +
   * version. If so, returns a URL which can be used to download the tarball. If
   * not, returns a 204 "No Content" response.
   */
  async #check(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.metrics.check++;
    if (this.#maybeServeForcedError(response, 'check')) {
      return;
    }
    if (!this.#checkAuthorization(request, response)) {
      return;
    }
    if (!this.#checkContentType(request, response, 'application/json')) {
      return;
    }
    if (!this.#checkAccept(request, response, JSON_RESPONSE_TYPE)) {
      return;
    }

    const json = await this.#readBody(request);
    const {key, version} = JSON.parse(json.toString()) as Partial<{
      key: string;
      version: string;
    }>;
    console.log({key, version});

    if (!key) {
      return this.#respond(response, 400, 'Missing "key" property');
    }
    if (!version) {
      return this.#respond(response, 400, 'Missing "version" property');
    }

    const keyAndVersion = encodeKeyAndVersion(key, version);
    const entryId = this.#keyAndVersionToEntryId.get(keyAndVersion);
    if (entryId === undefined) {
      return this.#respond(
        response,
        200,
        JSON.stringify({
          ok: true,
          signed_download_url: '',
          matched_key: '',
        }),
      );
    }
    const entry = this.#entryIdToEntry.get(entryId);
    if (entry === undefined) {
      // TODO(aomarks) Not actually sure how the server responds here since v2.
      return this.#respond(response, 500, 'Entry missing for id');
    }
    if (!entry.commited) {
      // TODO(aomarks) Not actually sure how the server responds here since v2.
      return this.#respond(response, /* No Content */ 204);
    }

    this.#respond(
      response,
      200,
      JSON.stringify({
        ok: true,
        signed_download_url: `${this.#url.href}tarballs/${entry.tarballId}`,
        matched_key: key,
      }),
    );
  }

  /**
   * Handle the POST:/_apis/artifactcache/caches API.
   *
   * This API checks if a cache entry has already been reserved for the given
   * key + version. If so, returns a "409 Conflict" response. If not, returns a
   * new unique cache ID which can be used to upload the tarball.
   */
  async #reserve(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    console.log('REEEEEESERVE');
    this.metrics.reserve++;
    if (this.#maybeServeForcedError(response, 'reserve')) {
      return;
    }
    if (!this.#checkAuthorization(request, response)) {
      return;
    }
    if (!this.#checkContentType(request, response, 'application/json')) {
      return;
    }
    if (!this.#checkAccept(request, response, JSON_RESPONSE_TYPE)) {
      return;
    }

    const json = await this.#readBody(request);
    const data = JSON.parse(json.toString()) as {
      key: string;
      version: string;
    };
    const keyAndVersion = encodeKeyAndVersion(data.key, data.version);
    if (this.#keyAndVersionToEntryId.has(keyAndVersion)) {
      return this.#respond(response, /* Conflict */ 409);
    }
    const entryId = String(this.#nextEntryId++) as EntryId;
    const tarballId = String(Math.random()).slice(2) as TarballId;
    this.#keyAndVersionToEntryId.set(keyAndVersion, entryId);
    this.#tarballIdToEntryId.set(tarballId, entryId);
    this.#entryIdToEntry.set(entryId, {
      chunks: new Map(),
      commited: false,
      tarballId,
    });
    const uploadUrl = new URL('blobs', this.#url);
    uploadUrl.searchParams.set('skoid', String(entryId));
    this.#respond(
      response,
      /* Created */ 201,
      JSON.stringify({
        signed_upload_url: uploadUrl.href,
      }),
    );
  }

  /**
   * Handle the PATCH:/_apis/artifactcache/caches/<CacheEntryId> API.
   *
   * This API receives a chunk of a tarball defined by the Content-Range header,
   * and stores it using the given key (as returned by the reserve cache API).
   */
  async #upload(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    console.log('UPLOAAAAAD', {url});
    this.metrics.upload++;
    if (this.#maybeServeForcedError(response, 'upload')) {
      return;
    }
    if (request.headers.authorization !== undefined) {
      this.#respond(response, /* Bad Request */ 400);
    }
    if (
      !this.#checkContentType(request, response, 'application/octet-stream')
    ) {
      return;
    }
    if (!this.#checkAccept(request, response, JSON_RESPONSE_TYPE)) {
      return;
    }

    const id = url.searchParams.get('skoid') as EntryId;
    if (!id) {
      return this.#respond(response, 400, 'Missing skoid parameter');
    }
    const blockId = url.searchParams.get('blockid');
    if (!blockId) {
      return this.#respond(response, 400, 'Missing blockid parameter');
    }
    if (url.searchParams.get('comp') !== 'block') {
      return this.#respond(response, 400, 'Missing comp=block parameter');
    }

    const entry = this.#entryIdToEntry.get(id);
    if (entry === undefined) {
      return this.#respond(response, 400, 'Cache entry did not exist');
    }

    const data = await this.#readBody(request);
    entry.chunks.set(blockId, data);
    this.#respond(response, /* No Content */ 204);
  }

  /**
   * Handle the POST:/_apis/artifactcache/caches/<CacheEntryId> API.
   *
   * This API marks an uploaded tarball (which can be sent in multiple chunks)
   * as complete.
   */
  async #commit(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.metrics.commit++;
    if (this.#maybeServeForcedError(response, 'commit')) {
      return;
    }
    if (!this.#checkAuthorization(request, response)) {
      return;
    }
    if (!this.#checkContentType(request, response, 'application/json')) {
      return;
    }
    if (!this.#checkAccept(request, response, JSON_RESPONSE_TYPE)) {
      return;
    }

    const json = await this.#readBody(request);
    const data = JSON.parse(json.toString()) as {
      key: string;
      version: string;
      sizeBytes: number;
    };

    console.log('PPPPPPPPPPPPP', this.#entryIdToEntry);
    const entry = this.#entryIdToEntry.get(data.key as EntryId);
    if (entry === undefined) {
      return this.#respond(response, 400, 'Cache entry did not exist');
    }

    // // Sort the chunks according to range and validate that there are no missing
    // // or overlapping chunks.
    // entry.chunks.sort((a, b) => a.start - b.start);
    // let expectedNextStart = 0;
    // let totalLength = 0;
    // for (const chunk of entry.chunks) {
    //   if (chunk.start !== expectedNextStart) {
    //     return this.#respond(
    //       response,
    //       400,
    //       'Cache entry chunks were not contiguous',
    //     );
    //   }
    //   expectedNextStart = chunk.end + 1;
    //   totalLength += chunk.buffer.length;
    // }

    // Validate against the expected total length from this request.
    // const json = await this.#readBody(request);
    // const data = JSON.parse(json.toString()) as {
    //   size: number;
    // };
    // const expectedLength = data.size;
    // if (totalLength !== expectedLength) {
    //   return this.#respond(
    //     response,
    //     400,
    //     'Cache entry did not match expected length',
    //   );
    // }

    // entry.commited = true;
    this.#respond(response, /* No Content */ 204);
  }

  /**
   * Handle the GET:/tarballs/<TarballId> API.
   *
   * This API returns the cached tarball for the given key.
   *
   * In reality, tarball URLs are on a different CDN server to the cache API
   * server. For simplicity we serve both from the same fake server.
   *
   * Note this API is not authenticated. Instead, the tarball URL is
   * unguessable.
   */
  #download(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    tarballId: string,
  ): void {
    this.metrics.download++;
    if (this.#maybeServeForcedError(response, 'download')) {
      return;
    }
    if (!this.#checkContentType(request, response, undefined)) {
      return;
    }
    if (!this.#checkAccept(request, response, undefined)) {
      return;
    }

    const id = this.#tarballIdToEntryId.get(tarballId as TarballId);
    if (id === undefined) {
      return this.#respond(response, 404, 'Tarball does not exist');
    }
    const entry = this.#entryIdToEntry.get(id);
    if (entry === undefined) {
      return this.#respond(response, 500, 'Entry did not exist');
    }
    if (!entry.commited) {
      return this.#respond(response, 404, 'Tarball not committed');
    }

    response.statusCode = 200;
    // const contentLength = entry.chunks.reduce(
    //   (sum, chunk) => sum + chunk.buffer.length,
    //   0,
    // );
    // response.setHeader('Content-Length', contentLength);
    // for (const chunk of entry.chunks) {
    //   response.write(chunk.buffer);
    // }
    response.end();
  }
}
