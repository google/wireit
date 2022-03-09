/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import * as http from 'http';

/**
 * A fake version of the GitHub Actions cache server.
 */
export class FakeGitHubCacheServer {
  private readonly _server: http.Server;
  private readonly _cache = new Map<string, Buffer[]>();

  constructor() {
    this._server = http.createServer(this._onRequest);
  }

  async listen(port: number) {
    await new Promise<void>((resolve) => {
      this._server.listen(port, () => {
        resolve();
      });
    });
  }

  async close() {
    return new Promise<void>((resolve) => {
      this._server.close(() => {
        resolve();
      });
    });
  }

  private _onRequest = (
    request: http.IncomingMessage,
    response: http.ServerResponse
  ) => {
    if (!request.url) {
      return this._notFound(response);
    }
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (
      request.method === 'GET' &&
      url.pathname === '/_apis/artifactcache/cache'
    ) {
      return this._onGetCache(request, response, url);
    } else if (
      request.method === 'POST' &&
      url.pathname === '/_apis/artifactcache/caches'
    ) {
      return this._onReserveCache(request, response);
    } else if (
      request.method === 'PATCH' &&
      url.pathname.startsWith('/_apis/artifactcache/caches/')
    ) {
      return this._onSaveCache(request, response, url);
    } else if (
      request.method === 'POST' &&
      url.pathname.startsWith('/_apis/artifactcache/caches/')
    ) {
      return this._onCommitCache(request, response, url);
    } else if (request.method === 'GET' && url.pathname.startsWith('/data/')) {
      return this._onGetData(request, response, url);
    } else {
      return this._notFound(response);
    }
  };

  private _notFound(response: http.ServerResponse) {
    response.statusCode = 404;
    response.end();
  }

  private _onGetCache(
    _request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL
  ) {
    // TODO(aomarks) There can be multiple comma-delimited keys.
    const keys = url.searchParams.get('keys');
    const version = url.searchParams.get('version');
    const key = `${keys}:${version}`;
    if (this._cache.has(key)) {
      response.statusCode = 200;
      response.write(
        JSON.stringify({
          archiveLocation: `http://localhost:3030/data/${keys}:${version}`,
          cacheKey: key,
        })
      );
    } else {
      response.statusCode = 204;
    }
    response.end();
  }

  private _onReserveCache(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ) {
    let jsonStr = '';
    request.on('data', (chunk) => {
      jsonStr += chunk;
    });

    request.on('end', () => {
      const json = JSON.parse(jsonStr) as {key: string; version: string};
      const cacheId = `${json.key}:${json.version}`;
      response.statusCode = 200;
      // TODO(aomarks) In reality there is an internal key that is different to
      // the key + version. Not sure why yet.
      response.write(JSON.stringify({cacheId}));
      response.end();
    });
  }

  private _onSaveCache(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL
  ) {
    // In reality, there could be multiple concurrent requests saving different
    // chunks of the same tarball, in the case that the tarball is large, with
    // the ranges specified in the Content-Range request headers. For this fake,
    // we just assume we'll never upload large tarballs, so we don't have to
    // worry about this.

    const key = url.pathname.slice('/_apis/artifactcache/caches/'.length);

    let chunks: Array<Buffer> = [];
    request.on('data', (chunk: unknown) => {
      chunks.push(chunk as Buffer);
    });

    request.on('end', () => {
      this._cache.set(key, chunks);
      response.statusCode = 200;
      response.end();
    });
  }

  private _onCommitCache(
    _request: http.IncomingMessage,
    response: http.ServerResponse,
    _url: URL
  ) {
    // TODO(aomarks) actually commit
    // const key = url.pathname.slice('/_apis/artifactcache/caches/'.length);
    response.statusCode = 200;
    response.end();
  }

  private _onGetData(
    _request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL
  ) {
    const key = url.pathname.slice('/data/'.length);
    const chunks = this._cache.get(key);
    if (chunks === undefined) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.statusCode = 200;
    const contentLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    response.setHeader('Content-Length', contentLength);
    for (const chunk of chunks) {
      response.write(chunk);
    }
    response.end();
  }
}
