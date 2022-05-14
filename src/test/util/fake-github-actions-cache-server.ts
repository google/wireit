/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as http from 'http';

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
  chunks: Buffer[];
  commited: boolean;
  tarballId: TarballId;
}

const encodeKeyAndVersion = (key: string, version: string): KeyAndVersion =>
  `${key}:${version}` as KeyAndVersion;

type ApiName = 'check' | 'reserve' | 'upload' | 'commit' | 'download';

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

  constructor(authToken: string) {
    this.#authToken = authToken;
    this.#server = http.createServer(this.#route);
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

  async listen(): Promise<void> {
    return new Promise((resolve) => {
      this.#server.listen(
        {
          host: 'localhost',
          port: /* random free */ 0,
        },
        () => {
          resolve();
        }
      );
    });
  }

  async close(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }

  get port(): number {
    const address = this.#server.address();
    if (address === null || typeof address !== 'object') {
      throw new Error(
        `Expected server address to be ServerInfo object, ` +
          `got ${JSON.stringify(address)}`
      );
    }
    return address.port;
  }

  rateLimitNextRequest(apiName: ApiName): void {
    this.#rateLimitNextRequest.add(apiName);
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

  #route = (
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): void => {
    if (!request.url) {
      return this.#respond(response, 404);
    }
    // Request.url is only the pathname + query params.
    const url = new URL(request.url, `http://localhost:${this.port}`);

    if (
      url.pathname === '/_apis/artifactcache/cache' &&
      request.method === 'GET'
    ) {
      return this.#check(request, response, url);
    }

    if (
      url.pathname === '/_apis/artifactcache/caches' &&
      request.method === 'POST'
    ) {
      return this.#reserve(request, response);
    }

    if (url.pathname.startsWith('/_apis/artifactcache/caches/')) {
      if (request.method === 'PATCH') {
        return this.#upload(request, response, url);
      }
      if (request.method === 'POST') {
        return this.#commit(request, response, url);
      }
    }

    if (url.pathname.startsWith('/tarballs/') && request.method === 'GET') {
      return this.#download(request, response, url);
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
        archiveLocation: `http://localhost:${this.port}/tarballs/${entry.tarballId}`,
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
  #reserve(request: http.IncomingMessage, response: http.ServerResponse): void {
    this.metrics.reserve++;
    if (this.#rateLimitNextRequest.delete('reserve')) {
      return this.#rateLimit(response);
    }
    if (!this.#checkAuthorization(request, response)) {
      return;
    }

    let jsonStr = '';
    request.on('data', (chunk) => {
      jsonStr += chunk;
    });

    request.on('end', () => {
      const json = JSON.parse(jsonStr) as {key: string; version: string};
      const keyAndVersion = encodeKeyAndVersion(json.key, json.version);
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
    });
  }

  /**
   * Handle the PATCH:/_apis/artifactcache/caches/<CacheEntryId> API.
   *
   * This API receives a tarball (or a chunk of a tarball) and stores it using
   * the given key (as returned by the reserve cache API).
   */
  #upload(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL
  ): void {
    this.metrics.upload++;
    if (this.#rateLimitNextRequest.delete('upload')) {
      return this.#rateLimit(response);
    }
    if (!this.#checkAuthorization(request, response)) {
      return;
    }

    const idStr = url.pathname.slice('/_apis/artifactcache/caches/'.length);
    if (idStr.match(/\d+/) === null) {
      return this.#respond(response, 400, 'Cache ID was not an integer');
    }
    const id = Number(idStr) as EntryId;
    const entry = this.#entryIdToEntry.get(id);
    if (entry === undefined) {
      return this.#respond(response, 400, 'Cache entry did not exist');
    }

    if (entry.chunks.length > 0) {
      // The real server supports multiple requests uploading different ranges
      // of the same tarball distinguished using the Content-Range header, for
      // large tarballs. However, our tests don't test this functionality, so we
      // don't bother implementing it.
      //
      // TODO(aomarks) We probably should actually try to cover this case.
      return this.#respond(
        response,
        501,
        'Multiple tarball upload requests not supported'
      );
    }

    request.on('data', (chunk: unknown) => {
      entry.chunks.push(chunk as Buffer);
    });

    request.on('end', () => {
      this.#respond(response, /* No Content */ 204);
    });
  }

  /**
   * Handle the POST:/_apis/artifactcache/caches/<CacheEntryId> API.
   *
   * This API marks a tarball uploaded by the onSaveCache API (which could be
   * sent in multiple chunks) as complete.
   */
  #commit(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL
  ): void {
    this.metrics.commit++;
    if (this.#rateLimitNextRequest.delete('commit')) {
      return this.#rateLimit(response);
    }
    if (!this.#checkAuthorization(request, response)) {
      return;
    }

    const idStr = url.pathname.slice('/_apis/artifactcache/caches/'.length);
    if (idStr.match(/\d+/) === null) {
      return this.#respond(response, 400, 'Cache ID was not an integer');
    }
    const id = Number(idStr) as EntryId;
    const entry = this.#entryIdToEntry.get(id);
    if (entry === undefined) {
      return this.#respond(response, 400, 'Cache entry did not exist');
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
    _request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL
  ): void {
    this.metrics.download++;
    if (this.#rateLimitNextRequest.delete('download')) {
      return this.#rateLimit(response);
    }

    const tarballId = url.pathname.slice('/tarballs/'.length) as TarballId;
    const id = this.#tarballIdToEntryId.get(tarballId);
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
      (acc, chunk) => acc + chunk.length,
      0
    );
    response.setHeader('Content-Length', contentLength);
    for (const chunk of entry.chunks) {
      response.write(chunk);
    }
    response.end();
  }
}
