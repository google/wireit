/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as https from 'https';
import type * as http from 'http';

/**
 * Numeric ID for a cache entry.
 */
type EntryId = number & {
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
  chunks: ChunkRange[];
  commited: boolean;
  tarballId: TarballId;
}

interface ChunkRange {
  start: number;
  end: number;
  buffer: Buffer;
}

const encodeKeyAndVersion = (key: string, version: string): KeyAndVersion =>
  `${key}:${version}` as KeyAndVersion;

type ApiName = 'check' | 'reserve' | 'upload' | 'commit' | 'download';

// https://github.com/actions/toolkit/blob/500d0b42fee2552ae9eeb5933091fe2fbf14e72d/packages/cache/src/internal/cacheHttpClient.ts#L55
const JSON_RESPONSE_TYPE = 'application/json;api-version=6.0-preview.1';

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
  private readonly _server: http.Server;
  private _url!: URL;

  /**
   * An authentication token which this server will require to be set in a
   * "Authorization: Bearer <token>" header.
   */
  private readonly _authToken;

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

  private _nextEntryId = 0;
  private _forcedErrors = new Map<ApiName, number | 'ECONNRESET'>();
  private readonly _entryIdToEntry = new Map<EntryId, CacheEntry>();
  private readonly _keyAndVersionToEntryId = new Map<KeyAndVersion, EntryId>();
  private readonly _tarballIdToEntryId = new Map<TarballId, EntryId>();

  constructor(authToken: string, tlsCert: {cert: string; key: string}) {
    this._authToken = authToken;
    this._server = https.createServer(tlsCert, this._route);
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
      this._server.listen({host, port: /* random free */ 0}, () => resolve());
    });
    const address = this._server.address();
    if (address === null || typeof address !== 'object') {
      throw new Error(
        `Expected server address to be ServerInfo object, ` +
          `got ${JSON.stringify(address)}`
      );
    }
    // The real API includes a unique identifier as the base path. It's good to
    // include this in the fake because it ensures the client is preserving the
    // base path and not just using the origin.
    const randomBasePath = Math.random().toString().slice(2);
    this._url = new URL(`https://${host}:${address.port}/${randomBasePath}/`);
    return this._url.href;
  }

  async close(): Promise<void> {
    return new Promise<void>((resolve) => {
      this._server.close(() => {
        resolve();
      });
    });
  }

  forceErrorOnNextRequest(apiName: ApiName, code: number | 'ECONNRESET'): void {
    this._forcedErrors.set(apiName, code);
  }

  private _readBody(request: http.IncomingMessage): Promise<Buffer> {
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

  private _respond(
    response: http.ServerResponse,
    status: number,
    message?: string
  ): void {
    response.statusCode = status;
    if (message !== undefined) {
      response.write(message);
    }
    response.end();
  }

  private _maybeServeForcedError(
    response: http.ServerResponse,
    apiName: ApiName
  ): boolean {
    const code = this._forcedErrors.get(apiName);
    if (code !== undefined) {
      this._forcedErrors.delete(apiName);
      if (code === 'ECONNRESET') {
        response.destroy();
      } else {
        this._respond(response, code, `Forcing ${code} error for ${apiName}`);
      }
      return true;
    }
    return false;
  }

  private _checkAuthorization(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): boolean {
    if (request.headers.authorization !== `Bearer ${this._authToken}`) {
      this._respond(response, /* Not Authorized */ 401);
      return false;
    }
    return true;
  }

  private _checkUserAgent(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): boolean {
    // https://github.com/actions/toolkit/blob/500d0b42fee2552ae9eeb5933091fe2fbf14e72d/packages/cache/src/internal/cacheHttpClient.ts#L67
    const expected = 'actions/cache';
    const actual = request.headers['user-agent'];
    if (actual !== expected) {
      // The real server might not be this strict, but we want to be sure we're
      // acting just like the official client library.
      this._respond(
        response,
        /* Bad Request */ 400,
        `Expected user-agent ${JSON.stringify(expected)}. ` +
          `Got ${JSON.stringify(actual)}.`
      );
      return false;
    }
    return true;
  }

  private _checkContentType(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    expected: string | undefined
  ): boolean {
    const actual = request.headers['content-type'];
    if (actual !== expected) {
      // The real server might not be this strict, but we want to be sure we're
      // acting just like the official client library.
      this._respond(
        response,
        /* Bad Request */ 400,
        `Expected content-type ${JSON.stringify(expected)}. ` +
          `Got ${JSON.stringify(actual)}.`
      );
      return false;
    }
    return true;
  }

  private _checkAccept(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    expected: string | undefined
  ): boolean {
    const actual = request.headers['accept'];
    if (actual !== expected) {
      // The real server might not be this strict, but we want to be sure we're
      // acting just like the official client library.
      this._respond(
        response,
        /* Bad Request */ 400,
        `Expected accept ${JSON.stringify(expected)}. ` +
          `Got ${JSON.stringify(actual)}.`
      );
      return false;
    }
    return true;
  }

  private _route = (
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): void => {
    if (!request.url) {
      return this._respond(response, 404);
    }
    // request.url is a string with pathname + query params.
    const url = new URL(request.url, this._url.origin);
    if (!url.pathname.startsWith(this._url.pathname)) {
      // Missing the random base path.
      return this._respond(response, 404);
    }
    const api = url.pathname.slice(this._url.pathname.length);

    if (!this._checkUserAgent(request, response)) {
      return;
    }

    if (api === '_apis/artifactcache/cache' && request.method === 'GET') {
      return this._check(request, response, url);
    }

    if (api === '_apis/artifactcache/caches' && request.method === 'POST') {
      return void this._reserve(request, response);
    }

    if (api.startsWith('_apis/artifactcache/caches/')) {
      const tail = api.slice('_apis/artifactcache/caches/'.length);
      if (request.method === 'PATCH') {
        return void this._upload(request, response, tail);
      }
      if (request.method === 'POST') {
        return void this._commit(request, response, tail);
      }
    }

    if (api.startsWith('tarballs/') && request.method === 'GET') {
      const tail = api.slice('tarballs/'.length);
      return this._download(request, response, tail);
    }

    this._respond(response, 404);
  };

  /**
   * Handle the GET:/_apis/artifactcache/cache API.
   *
   * This API checks if a (committed) cache entry exists for the given key +
   * version. If so, returns a URL which can be used to download the tarball. If
   * not, returns a 204 "No Content" response.
   */
  private _check(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL
  ): void {
    this.metrics.check++;
    if (this._maybeServeForcedError(response, 'check')) {
      return;
    }
    if (!this._checkAuthorization(request, response)) {
      return;
    }
    if (!this._checkContentType(request, response, undefined)) {
      return;
    }
    if (!this._checkAccept(request, response, JSON_RESPONSE_TYPE)) {
      return;
    }

    const keys = url.searchParams.get('keys');
    if (!keys) {
      return this._respond(response, 400, 'Missing "keys" query parameter');
    }
    const version = url.searchParams.get('version');
    if (!version) {
      return this._respond(response, 400, 'Missing "version" query parameter');
    }
    if (keys.includes(',')) {
      // The real server supports multiple comma-delimited keys, where the first
      // that exists is returned. However, we don't use this feature in Wireit,
      // so we don't bother implementing it in this fake.
      return this._respond(
        response,
        /* Not Implemented */ 501,
        'Fake does not support multiple keys'
      );
    }

    const keyAndVersion = encodeKeyAndVersion(keys, version);
    const entryId = this._keyAndVersionToEntryId.get(keyAndVersion);
    if (entryId === undefined) {
      return this._respond(response, /* No Content */ 204);
    }
    const entry = this._entryIdToEntry.get(entryId);
    if (entry === undefined) {
      return this._respond(response, 500, 'Entry missing for id');
    }
    if (!entry.commited) {
      return this._respond(response, /* No Content */ 204);
    }

    this._respond(
      response,
      200,
      JSON.stringify({
        archiveLocation: `${this._url.href}tarballs/${entry.tarballId}`,
        cacheKey: keys,
      })
    );
  }

  /**
   * Handle the POST:/_apis/artifactcache/caches API.
   *
   * This API checks if a cache entry has already been reserved for the given
   * key + version. If so, returns a "409 Conflict" response. If not, returns a
   * new unique cache ID which can be used to upload the tarball.
   */
  private async _reserve(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    this.metrics.reserve++;
    if (this._maybeServeForcedError(response, 'reserve')) {
      return;
    }
    if (!this._checkAuthorization(request, response)) {
      return;
    }
    if (!this._checkContentType(request, response, 'application/json')) {
      return;
    }
    if (!this._checkAccept(request, response, JSON_RESPONSE_TYPE)) {
      return;
    }

    const json = await this._readBody(request);
    const data = JSON.parse(json.toString()) as {
      key: string;
      version: string;
    };
    const keyAndVersion = encodeKeyAndVersion(data.key, data.version);
    if (this._keyAndVersionToEntryId.has(keyAndVersion)) {
      return this._respond(response, /* Conflict */ 409);
    }
    const entryId = this._nextEntryId++ as EntryId;
    const tarballId = String(Math.random()).slice(2) as TarballId;
    this._keyAndVersionToEntryId.set(keyAndVersion, entryId);
    this._tarballIdToEntryId.set(tarballId, entryId);
    this._entryIdToEntry.set(entryId, {
      chunks: [],
      commited: false,
      tarballId,
    });
    this._respond(
      response,
      /* Created */ 201,
      JSON.stringify({cacheId: entryId})
    );
  }

  /**
   * Handle the PATCH:/_apis/artifactcache/caches/<CacheEntryId> API.
   *
   * This API receives a chunk of a tarball defined by the Content-Range header,
   * and stores it using the given key (as returned by the reserve cache API).
   */
  private async _upload(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    idStr: string
  ): Promise<void> {
    this.metrics.upload++;
    if (this._maybeServeForcedError(response, 'upload')) {
      return;
    }
    if (!this._checkAuthorization(request, response)) {
      return;
    }
    if (
      !this._checkContentType(request, response, 'application/octet-stream')
    ) {
      return;
    }
    if (!this._checkAccept(request, response, JSON_RESPONSE_TYPE)) {
      return;
    }
    const expectedTransferEncoding = 'chunked';
    const actualTransferEncoding = request.headers['transfer-encoding'];
    if (actualTransferEncoding !== 'chunked') {
      return this._respond(
        response,
        /* Bad Request */ 400,
        `Expected transfer-encoding ${JSON.stringify(
          expectedTransferEncoding
        )}. ` + `Got ${String(actualTransferEncoding)}.`
      );
    }

    if (idStr.match(/\d+/) === null) {
      return this._respond(response, 400, 'Cache ID was not an integer');
    }
    const id = Number(idStr) as EntryId;
    const entry = this._entryIdToEntry.get(id);
    if (entry === undefined) {
      return this._respond(response, 400, 'Cache entry did not exist');
    }

    const contentRange = request.headers['content-range'] ?? '';
    const parsedContentRange = contentRange.match(/^bytes (\d+)-(\d+)\/\*$/);
    if (parsedContentRange === null) {
      return this._respond(
        response,
        400,
        'Missing or invalid Content-Range header'
      );
    }
    const start = Number(parsedContentRange[1]);
    const end = Number(parsedContentRange[2]);
    const expectedLength = end - start + 1;

    // The real server might not be this strict, but we should make sure we
    // aren't sending larger chunks than the official client library does.
    // https://github.com/actions/toolkit/blob/500d0b42fee2552ae9eeb5933091fe2fbf14e72d/packages/cache/src/options.ts#L59
    if (expectedLength > 32 * 1024 * 1024) {
      return this._respond(response, 400, 'Upload chunk was > 32MB');
    }

    const buffer = await this._readBody(request);
    if (buffer.length !== expectedLength) {
      return this._respond(
        response,
        400,
        'Chunk length did not match Content-Range header'
      );
    }
    entry.chunks.push({start, end, buffer});
    this._respond(response, /* No Content */ 204);
  }

  /**
   * Handle the POST:/_apis/artifactcache/caches/<CacheEntryId> API.
   *
   * This API marks an uploaded tarball (which can be sent in multiple chunks)
   * as complete.
   */
  private async _commit(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    idStr: string
  ): Promise<void> {
    this.metrics.commit++;
    if (this._maybeServeForcedError(response, 'commit')) {
      return;
    }
    if (!this._checkAuthorization(request, response)) {
      return;
    }
    if (!this._checkContentType(request, response, 'application/json')) {
      return;
    }
    if (!this._checkAccept(request, response, JSON_RESPONSE_TYPE)) {
      return;
    }

    if (idStr.match(/\d+/) === null) {
      return this._respond(response, 400, 'Cache ID was not an integer');
    }

    const id = Number(idStr) as EntryId;
    const entry = this._entryIdToEntry.get(id);
    if (entry === undefined) {
      return this._respond(response, 400, 'Cache entry did not exist');
    }

    // Sort the chunks according to range and validate that there are no missing
    // or overlapping chunks.
    entry.chunks.sort((a, b) => a.start - b.start);
    let expectedNextStart = 0;
    let totalLength = 0;
    for (const chunk of entry.chunks) {
      if (chunk.start !== expectedNextStart) {
        return this._respond(
          response,
          400,
          'Cache entry chunks were not contiguous'
        );
      }
      expectedNextStart = chunk.end + 1;
      totalLength += chunk.buffer.length;
    }

    // Validate against the expected total length from this request.
    const json = await this._readBody(request);
    const data = JSON.parse(json.toString()) as {
      size: number;
    };
    const expectedLength = data.size;
    if (totalLength !== expectedLength) {
      return this._respond(
        response,
        400,
        'Cache entry did not match expected length'
      );
    }

    entry.commited = true;
    this._respond(response, /* No Content */ 204);
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
  private _download(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    tarballId: string
  ): void {
    this.metrics.download++;
    if (this._maybeServeForcedError(response, 'download')) {
      return;
    }
    if (!this._checkContentType(request, response, undefined)) {
      return;
    }
    if (!this._checkAccept(request, response, undefined)) {
      return;
    }

    const id = this._tarballIdToEntryId.get(tarballId as TarballId);
    if (id === undefined) {
      return this._respond(response, 404, 'Tarball does not exist');
    }
    const entry = this._entryIdToEntry.get(id);
    if (entry === undefined) {
      return this._respond(response, 500, 'Entry did not exist');
    }
    if (!entry.commited) {
      return this._respond(response, 404, 'Tarball not committed');
    }

    response.statusCode = 200;
    const contentLength = entry.chunks.reduce(
      (sum, chunk) => sum + chunk.buffer.length,
      0
    );
    response.setHeader('Content-Length', contentLength);
    for (const chunk of entry.chunks) {
      response.write(chunk.buffer);
    }
    response.end();
  }
}
