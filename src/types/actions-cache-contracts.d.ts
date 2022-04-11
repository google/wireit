/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// TODO(aomarks) File or upstream a fix for this file being missing from
// @actions/cache. Though note it only affects users who are importing directly
// from the internal/ directory, which is a weird unsupported thing to do.
// Upstreaming changes that would let us import from the public modules would be
// even better.
//
// Source:
// https://github.com/actions/toolkit/blob/f8a69bc473af4a204d0c03de61d5c9d1300dfb17/packages/cache/src/internal/contracts.d.ts
declare module '@actions/cache/lib/internal/contracts.js' {
  import type {HttpClientError} from '@actions/http-client';
  import type {ITypedResponse} from '@actions/http-client/interfaces.js';

  interface ReserveCacheRequest {
    key: string;
    version?: string;
    cacheSize?: number;
  }

  interface ReserveCacheResponse {
    cacheId: number;
  }

  interface ITypedResponseWithError<T> extends ITypedResponse<T> {
    error?: HttpClientError;
  }

  interface ArtifactCacheEntry {
    cacheKey?: string;
    scope?: string;
    creationTime?: string;
    archiveLocation?: string;
  }
}
