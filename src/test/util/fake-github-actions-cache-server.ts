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
  #rateLimitNextRequest = new Set<ApiName>();
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
          `got ${JSON.stringify(address)}`
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

  rateLimitNextRequest(apiName: ApiName): void {
    this.#rateLimitNextRequest.add(apiName);
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
    message?: string
  ): void {
    response.statusCode = status;
    if (message !== undefined) {
      response.write(message);
    }
    response.end();
  }

  #rateLimit(response: http.ServerResponse): void {
    return this.#respond(response, /* Too Many Requests */ 429);
  }

  #checkAuthorization(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): boolean {
    if (request.headers.authorization !== `Bearer ${this.#authToken}`) {
      this.#respond(response, /* Not Authorized */ 401);
      return false;
    }
    return true;
  }

  #checkUserAgent(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): boolean {
    // https://github.com/actions/toolkit/blob/500d0b42fee2552ae9eeb5933091fe2fbf14e72d/packages/cache/src/internal/cacheHttpClient.ts#L67
    const expected = 'actions/cache';
    const actual = request.headers['user-agent'];
    if (actual !== expected) {
      // The real server might not be this strict, but we want to be sure we're
      // acting just like the official client library.
      this.#respond(
        response,
        /* Bad Request */ 400,
        `Expected user-agent ${JSON.stringify(expected)}. ` +
          `Got ${JSON.stringify(actual)}.`
      );
      return false;
    }
    return true;
  }

  #checkContentType(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    expected: string | undefined
  ): boolean {
    const actual = request.headers['content-type'];
    if (actual !== expected) {
      // The real server might not be this strict, but we want to be sure we're
      // acting just like the official client library.
      this.#respond(
        response,
        /* Bad Request */ 400,
        `Expected content-type ${JSON.stringify(expected)}. ` +
          `Got ${JSON.stringify(actual)}.`
      );
      return false;
    }
    return true;
  }

  #checkAccept(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    expected: string | undefined
  ): boolean {
    const actual = request.headers['accept'];
    if (actual !== expected) {
      // The real server might not be this strict, but we want to be sure we're
      // acting just like the official client library.
      this.#respond(
        response,
        /* Bad Request */ 400,
        `Expected accept ${JSON.stringify(expected)}. ` +
          `Got ${JSON.stringify(actual)}.`
      );
      return false;
    }
    return true;
  }

  #route = (
    request: http.IncomingMessage,
    response: http.ServerResponse
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

    if (api === '_apis/artifactcache/cache' && request.method === 'GET') {
      return this.#check(request, response, url);
    }

    if (api === '_apis/artifactcache/caches' && request.method === 'POST') {
      return void this.#reserve(request, response);
    }

    if (api.startsWith('_apis/artifactcache/caches/')) {
      const tail = api.slice('_apis/artifactcache/caches/'.length);
      if (request.method === 'PATCH') {
        return void this.#upload(request, response, tail);
      }
      if (request.method === 'POST') {
        return void this.#commit(request, response, tail);
      }
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
  #check(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL
  ): void {
    this.metrics.check++;
    if (this.#rateLimitNextRequest.delete('check')) {
      return this.#rateLimit(response);
    }
    if (!this.#checkAuthorization(request, response)) {
      return;
    }
    if (!this.#checkContentType(request, response, undefined)) {
      return;
    }
    if (!this.#checkAccept(request, response, JSON_RESPONSE_TYPE)) {
      return;
    }

    const keys = url.searchParams.get('keys');
    if (!keys) {
      return this.#respond(response, 400, 'Missing "keys" query parameter');
    }
    const version = url.searchParams.get('version');
    if (!version) {
      return this.#respond(response, 400, 'Missing "version" query parameter');
    }
    if (keys.includes(',')) {
      // The real server supports multiple comma-delimited keys, where the first
      // that exists is returned. However, we don't use this feature in Wireit,
      // so we don't bother implementing it in this fake.
      return this.#respond(
        response,
        /* Not Implemented */ 501,
        'Fake does not support multiple keys'
      );
    }

    const keyAndVersion = encodeKeyAndVersion(keys, version);
    const entryId = this.#keyAndVersionToEntryId.get(keyAndVersion);
    if (entryId === undefined) {
      return this.#respond(response, /* No Content */ 204);
    }
    const entry = this.#entryIdToEntry.get(entryId);
    if (entry === undefined) {
      return this.#respond(response, 500, 'Entry missing for id');
    }
    if (!entry.commited) {
      return this.#respond(response, /* No Content */ 204);
    }

    this.#respond(
      response,
      200,
      JSON.stringify({
        archiveLocation: `${this.#url.href}tarballs/${entry.tarballId}`,
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
  async #reserve(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    this.metrics.reserve++;
    if (this.#rateLimitNextRequest.delete('reserve')) {
      return this.#rateLimit(response);
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
    const entryId = this.#nextEntryId++ as EntryId;
    const tarballId = String(Math.random()).slice(2) as TarballId;
    this.#keyAndVersionToEntryId.set(keyAndVersion, entryId);
    this.#tarballIdToEntryId.set(tarballId, entryId);
    this.#entryIdToEntry.set(entryId, {
      chunks: [],
      commited: false,
      tarballId,
    });
    this.#respond(
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
  async #upload(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    idStr: string
  ): Promise<void> {
    this.metrics.upload++;
    if (this.#rateLimitNextRequest.delete('upload')) {
      return this.#rateLimit(response);
    }
    if (!this.#checkAuthorization(request, response)) {
      return;
    }
    if (
      !this.#checkContentType(request, response, 'application/octet-stream')
    ) {
      return;
    }
    if (!this.#checkAccept(request, response, JSON_RESPONSE_TYPE)) {
      return;
    }

    if (idStr.match(/\d+/) === null) {
      return this.#respond(response, 400, 'Cache ID was not an integer');
    }
    const id = Number(idStr) as EntryId;
    const entry = this.#entryIdToEntry.get(id);
    if (entry === undefined) {
      return this.#respond(response, 400, 'Cache entry did not exist');
    }

    const contentRange = request.headers['content-range'] ?? '';
    const parsedContentRange = contentRange.match(/^bytes (\d+)-(\d+)\/\*$/);
    if (parsedContentRange === null) {
      return this.#respond(
        response,
        400,
        'Missing or invalid Content-Range header'
      );
    }
    const start = Number(parsedContentRange[1]);
    const end = Number(parsedContentRange[2]);
    const expectedLength = end - start + 1;

    const buffer = await this.#readBody(request);
    if (buffer.length !== expectedLength) {
      return this.#respond(
        response,
        400,
        'Chunk length did not match Content-Range header'
      );
    }
    entry.chunks.push({start, end, buffer});
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
    idStr: string
  ): Promise<void> {
    this.metrics.commit++;
    if (this.#rateLimitNextRequest.delete('commit')) {
      return this.#rateLimit(response);
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

    if (idStr.match(/\d+/) === null) {
      return this.#respond(response, 400, 'Cache ID was not an integer');
    }

    const id = Number(idStr) as EntryId;
    const entry = this.#entryIdToEntry.get(id);
    if (entry === undefined) {
      return this.#respond(response, 400, 'Cache entry did not exist');
    }

    // Sort the chunks according to range and validate that there are no missing
    // or overlapping chunks.
    entry.chunks.sort((a, b) => a.start - b.start);
    let expectedNextStart = 0;
    let totalLength = 0;
    for (const chunk of entry.chunks) {
      if (chunk.start !== expectedNextStart) {
        return this.#respond(
          response,
          400,
          'Cache entry chunks were not contiguous'
        );
      }
      expectedNextStart = chunk.end + 1;
      totalLength += chunk.buffer.length;
    }

    // Validate against the expected total length from this request.
    const json = await this.#readBody(request);
    const data = JSON.parse(json.toString()) as {
      size: number;
    };
    const expectedLength = data.size;
    if (totalLength !== expectedLength) {
      return this.#respond(
        response,
        400,
        'Cache entry did not match expected length'
      );
    }

    entry.commited = true;
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
    tarballId: string
  ): void {
    this.metrics.download++;
    if (this.#rateLimitNextRequest.delete('download')) {
      return this.#rateLimit(response);
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
