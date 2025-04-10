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
 * Random ID for a blob on the CDN.
 */
type BlobId = string & {
  __BlobIdBrand__: never;
};

/**
 * Cache key + version as a compound string (only used internally to this fake
 * as a Map key).
 */
type KeyAndVersion = string & {
  __KeyAndVersionBrand__: never;
};

interface CacheEntry {
  blocks: Map<string, Buffer>;
  blockList: string[];
  finalized: boolean;
  blobId: BlobId;
}

const encodeKeyAndVersion = (key: string, version: string): KeyAndVersion =>
  `${key}:${version}` as KeyAndVersion;

type ApiName =
  | 'getCacheEntry'
  | 'createCacheEntry'
  | 'putBlobBlock'
  | 'putBlobBlockList'
  | 'finalizeCacheEntry'
  | 'getBlob';

export type FakeGitHubActionsCacheServerMetrics = {
  getCacheEntry: number;
  createCacheEntry: number;
  putBlobBlock: number;
  putBlobBlockList: number;
  finalizeCacheEntry: number;
  getBlob: number;
};

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
 *     - Server returns a URL of a tarball as an Azure Storage blob.
 *     - Client downloads tarball and unpacks it.
 *     - <STOP>
 *   - If not exists:
 *     - Server returns { ok: false }
 *
 * - Client asks server to create a cache entry for a given key+version.
 *   - If entry was already created:
 *     - Server returns a "409 Conflict" status.
 *     - <STOP>
 *   - If not already exists:
 *     - Server returns a blob upload URL.
 *
 * - Client sends 1 or more "Put Block" requests to blob URL containing blocks
 *   of the tarball.
 *
 * - Client sends "Put Block List" request to blob URL containing the final
 *   ordered list of block IDs to commit.
 *
 * - Client sends "finalize" request to indicate that the blob is ready to be
 *   served as a hit.
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
  metrics!: FakeGitHubActionsCacheServerMetrics;

  #nextEntryId = 0;
  #forcedErrors = new Map<ApiName, number | 'ECONNRESET'>();
  readonly #entryIdToEntry = new Map<EntryId, CacheEntry>();
  readonly #keyAndVersionToEntryId = new Map<KeyAndVersion, EntryId>();
  readonly #blobIdToEntryId = new Map<BlobId, EntryId>();

  constructor(authToken: string, tlsCert: {cert: string; key: string}) {
    this.#authToken = authToken;
    this.#server = https.createServer(tlsCert, this.#route);
    this.resetMetrics();
  }

  resetMetrics(): void {
    this.metrics = {
      getCacheEntry: 0,
      createCacheEntry: 0,
      putBlobBlock: 0,
      putBlobBlockList: 0,
      finalizeCacheEntry: 0,
      getBlob: 0,
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
          `Got ${JSON.stringify(actual)}.`,
      );
      return false;
    }
    return true;
  }

  #checkContentType(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    expected: string | undefined,
  ): boolean {
    const actual = request.headers['content-type'];
    if (actual !== expected) {
      // The real server might not be this strict, but we want to be sure we're
      // acting just like the official client library.
      this.#respond(
        response,
        /* Bad Request */ 400,
        `Expected content-type ${JSON.stringify(expected)}. ` +
          `Got ${JSON.stringify(actual)}.`,
      );
      return false;
    }
    return true;
  }

  #checkAccept(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    expected: string | undefined,
  ): boolean {
    const actual = request.headers['accept'];
    if (actual !== expected) {
      // The real server might not be this strict, but we want to be sure we're
      // acting just like the official client library.
      this.#respond(
        response,
        /* Bad Request */ 400,
        `Expected accept ${JSON.stringify(expected)}. ` +
          `Got ${JSON.stringify(actual)}.`,
      );
      return false;
    }
    return true;
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

    if (
      api ===
        'twirp/github.actions.results.api.v1.CacheService/GetCacheEntryDownloadURL' &&
      request.method === 'POST'
    ) {
      return void this.#getCacheEntry(request, response);
    }

    if (
      api ===
        'twirp/github.actions.results.api.v1.CacheService/CreateCacheEntry' &&
      request.method === 'POST'
    ) {
      return void this.#createCacheEntry(request, response);
    }

    if (
      api ===
        'twirp/github.actions.results.api.v1.CacheService/FinalizeCacheEntryUpload' &&
      request.method === 'POST'
    ) {
      return void this.#finalizeCacheEntry(request, response);
    }

    if (api.startsWith('blob/')) {
      const tail = api.slice('blob/'.length);
      if (request.method === 'PUT') {
        // In the Azure Storage API, "comp" seems to stand for "component", and it
        // means something like "operation".
        const comp = url.searchParams.get('comp');
        if (comp === 'block') {
          return void this.#putBlobBlock(request, response, tail, url);
        }
        if (comp === 'blocklist') {
          return void this.#putBlobBlockList(request, response, tail);
        }
      } else if (request.method === 'GET') {
        return this.#getBlob(request, response, tail);
      }
    }

    this.#respond(response, 404);
  };

  /**
   * This API checks if a (finalized) cache entry exists for the given key +
   * version. If so, returns a URL which can be used to download the tarball. If
   * not, returns { ok: false }.
   */
  async #getCacheEntry(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.metrics.getCacheEntry++;
    if (this.#maybeServeForcedError(response, 'getCacheEntry')) {
      return;
    }
    if (!this.#checkAuthorization(request, response)) {
      return;
    }
    if (!this.#checkContentType(request, response, 'application/json')) {
      return;
    }
    if (!this.#checkAccept(request, response, 'application/json')) {
      return;
    }

    const json = await this.#readBody(request);
    const data = JSON.parse(json.toString()) as {
      key: string;
      version: string;
    };

    if (!data.key) {
      return this.#respond(response, 400, 'Missing "key" property');
    }
    if (!data.version) {
      return this.#respond(response, 400, 'Missing "version" property');
    }

    const keyAndVersion = encodeKeyAndVersion(data.key, data.version);
    const entryId = this.#keyAndVersionToEntryId.get(keyAndVersion);
    if (entryId === undefined) {
      return this.#respond(
        response,
        200,
        JSON.stringify({ok: false, signed_download_url: ''}),
      );
    }
    const entry = this.#entryIdToEntry.get(entryId);
    if (entry === undefined) {
      return this.#respond(response, 500, 'Entry missing for id');
    }
    if (!entry.finalized) {
      return this.#respond(
        response,
        200,
        JSON.stringify({ok: false, signed_download_url: ''}),
      );
    }

    return this.#respond(
      response,
      200,
      JSON.stringify({
        ok: true,
        signed_download_url: `${this.#url.href}blob/${entry.blobId}`,
      }),
    );
  }

  /**
   * This API checks if a cache entry has already been created for the given
   * key + version. If so, returns a "409 Conflict" response. If not, returns a
   * new URL which can be used to upload the tarball.
   */
  async #createCacheEntry(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.metrics.createCacheEntry++;
    if (this.#maybeServeForcedError(response, 'createCacheEntry')) {
      return;
    }
    if (!this.#checkAuthorization(request, response)) {
      return;
    }
    if (!this.#checkContentType(request, response, 'application/json')) {
      return;
    }
    if (!this.#checkAccept(request, response, 'application/json')) {
      return;
    }

    const json = await this.#readBody(request);
    const data = JSON.parse(json.toString()) as {
      key: string;
      version: string;
    };
    const keyAndVersion = encodeKeyAndVersion(data.key, data.version);
    if (this.#keyAndVersionToEntryId.has(keyAndVersion)) {
      return this.#respond(
        response,
        /* Conflict */ 409,
        JSON.stringify({
          code: 'already_exists',
          msg: 'cache entry with the same key, version, and scope already exists',
        }),
      );
    }
    const entryId = this.#nextEntryId++ as EntryId;
    const blobId = String(Math.random()).slice(2) as BlobId;
    this.#keyAndVersionToEntryId.set(keyAndVersion, entryId);
    this.#blobIdToEntryId.set(blobId, entryId);
    this.#entryIdToEntry.set(entryId, {
      blocks: new Map(),
      blockList: [],
      finalized: false,
      blobId: blobId,
    });
    this.#respond(
      response,
      200,
      JSON.stringify({
        ok: true,
        signed_upload_url: new URL(`blob/${blobId}`, this.#url),
      }),
    );
  }

  /**
   * Writes a block to a blob.
   * https://learn.microsoft.com/en-us/rest/api/storageservices/put-block
   */
  async #putBlobBlock(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    blobId: string,
    url: URL,
  ): Promise<void> {
    this.metrics.putBlobBlock++;
    if (this.#maybeServeForcedError(response, 'putBlobBlock')) {
      return;
    }
    // The blob URLs are self-signed.
    if (!this.#checkHeader(request, response, 'Authorization', undefined)) {
      return;
    }
    if (
      !this.#checkContentType(request, response, 'application/octet-stream')
    ) {
      return;
    }
    if (!this.#checkAccept(request, response, 'application/json')) {
      return;
    }
    if (!this.#checkHeader(request, response, 'x-ms-blob-type', 'BlockBlob')) {
      return;
    }
    const entryId = this.#blobIdToEntryId.get(blobId as BlobId);
    if (entryId === undefined) {
      return this.#respond(response, 400, 'Cache entry did not exist');
    }
    const entry = this.#entryIdToEntry.get(entryId);
    if (entry === undefined) {
      return this.#respond(response, 500, 'Cache entry did not exist');
    }
    const blockIdBase64 = url.searchParams.get('blockid');
    if (!blockIdBase64) {
      return this.#respond(response, 400, 'Missing blockid parameter');
    }
    const blockId = Buffer.from(blockIdBase64, 'base64').toString();

    const expectedLength = Number(request.headers['content-length']);

    // The real server might not be this strict, but we should make sure we
    // aren't sending larger chunks than the official client library does.
    // https://github.com/actions/toolkit/blob/500d0b42fee2552ae9eeb5933091fe2fbf14e72d/packages/cache/src/options.ts#L59
    if (expectedLength > 32 * 1024 * 1024) {
      return this.#respond(response, 400, 'Upload chunk was > 32MB');
    }

    const buffer = await this.#readBody(request);
    if (buffer.length !== expectedLength) {
      return this.#respond(
        response,
        400,
        'Block length did not match Content-Length header',
      );
    }
    entry.blocks.set(blockId, buffer);
    this.#respond(response, /* Created */ 201);
  }

  /**
   * Commits an ordered block list to a blob.
   * https://learn.microsoft.com/en-us/rest/api/storageservices/put-block-list
   */
  async #putBlobBlockList(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    blobId: string,
  ): Promise<void> {
    this.metrics.putBlobBlockList++;
    if (this.#maybeServeForcedError(response, 'putBlobBlockList')) {
      return;
    }
    // The blob URLs are self-signed.
    if (!this.#checkHeader(request, response, 'Authorization', undefined)) {
      return;
    }
    if (
      !this.#checkContentType(request, response, 'text/plain; charset=UTF-8')
    ) {
      return;
    }
    if (!this.#checkAccept(request, response, 'application/json')) {
      return;
    }
    const entryId = this.#blobIdToEntryId.get(blobId as BlobId);
    if (entryId === undefined) {
      return this.#respond(response, 400, 'Cache entry did not exist');
    }
    const entry = this.#entryIdToEntry.get(entryId);
    if (entry === undefined) {
      return this.#respond(response, 500, 'Cache entry did not exist');
    }
    if (entry.blockList.length > 0) {
      return this.#respond(response, 500, 'Block list already exists');
    }

    const xml = (await this.#readBody(request)).toString();
    const blockList = xml.match(/<BlockList>(.*?)<\/BlockList>/s);
    if (!blockList?.[1]) {
      return this.#respond(response, 500, 'No <BlockList> section');
    }
    const blocks = blockList[1].matchAll(/<(.*)>(.*?)<(\/\1)>/g);
    for (const [_, kind, base64BlockId] of blocks) {
      if (kind !== 'Uncommitted') {
        return this.#respond(response, 500, `Unexpected <${kind}>`);
      }
      if (!base64BlockId) {
        return this.#respond(response, 500, 'Empty <Uncommitted>');
      }
      const blockId = Buffer.from(base64BlockId, 'base64').toString();
      if (!entry.blocks.has(blockId)) {
        return this.#respond(response, 500, `Block ${blockId} does not exist`);
      }
      entry.blockList.push(blockId);
    }
    this.#respond(response, /* Created */ 201);
  }

  /**
   * This API marks a cache entry as finalized.
   */
  async #finalizeCacheEntry(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.metrics.finalizeCacheEntry++;
    if (this.#maybeServeForcedError(response, 'finalizeCacheEntry')) {
      return;
    }
    if (!this.#checkAuthorization(request, response)) {
      return;
    }
    if (!this.#checkContentType(request, response, 'application/json')) {
      return;
    }
    if (!this.#checkAccept(request, response, 'application/json')) {
      return;
    }

    const json = await this.#readBody(request);
    const data = JSON.parse(json.toString()) as {
      key: string;
      version: string;
      sizeBytes: number;
    };
    if (!data.key) {
      return this.#respond(response, 400, 'Missing "key" property');
    }
    if (!data.version) {
      return this.#respond(response, 400, 'Missing "version" property');
    }
    if (data.sizeBytes == null) {
      return this.#respond(response, 400, 'Missing "sizeBytes" property');
    }
    const keyAndVersion = encodeKeyAndVersion(data.key, data.version);
    const entryId = this.#keyAndVersionToEntryId.get(keyAndVersion);
    if (entryId === undefined) {
      return this.#respond(response, 400, 'Cache entry did not exist');
    }
    const entry = this.#entryIdToEntry.get(entryId);
    if (entry === undefined) {
      return this.#respond(response, 500, 'Cache entry did not exist');
    }

    entry.finalized = true;
    this.#respond(response, 200, JSON.stringify({ok: true}));
  }

  /**
   * This API returns the cached tarball for the given key.
   *
   * In reality, tarball URLs are on a different CDN server to the cache API
   * server. For simplicity we serve both from the same fake server.
   *
   * Note this API is not authenticated. Instead, the tarball URL is
   * unguessable.
   */
  #getBlob(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    blobId: string,
  ): void {
    this.metrics.getBlob++;
    if (this.#maybeServeForcedError(response, 'getBlob')) {
      return;
    }
    if (!this.#checkContentType(request, response, undefined)) {
      return;
    }
    if (!this.#checkAccept(request, response, undefined)) {
      return;
    }

    const entryId = this.#blobIdToEntryId.get(blobId as BlobId);
    if (entryId === undefined) {
      return this.#respond(response, 404, 'Cache entry does not exist');
    }
    const entry = this.#entryIdToEntry.get(entryId);
    if (entry === undefined) {
      return this.#respond(response, 500, 'Cache entry did not exist');
    }
    if (!entry.finalized) {
      return this.#respond(response, 404, 'Cache entry not finalized');
    }

    const orderedBlocks = entry.blockList.map((blockId) =>
      entry.blocks.get(blockId),
    );
    if (orderedBlocks.some((block) => !block)) {
      return this.#respond(response, 500, 'Block missing from block list');
    }
    response.statusCode = 200;
    const contentLength = orderedBlocks.reduce(
      (sum, block) => sum + (block?.length ?? 0),
      0,
    );
    response.setHeader('Content-Length', contentLength);
    for (const block of orderedBlocks) {
      response.write(block);
    }
    response.end();
  }
}
