/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createHash} from 'crypto';
import {createReadStream} from './util/fs.js';
import {glob} from './util/glob.js';
import {scriptReferenceToString} from './config.js';

import type {
  ScriptConfig,
  ScriptReferenceString,
  Dependency,
} from './config.js';
import {Result} from './error.js';
import {Failure} from './event.js';

/**
 * All meaningful inputs of a script. Used for determining if a script is fresh,
 * and as the key for storing cached output.
 */
export interface FingerprintData {
  /**
   * Brand to make it slightly harder to create one of these interfaces, because
   * that should only ever be done via {@link Fingerprint.compute}.
   */
  __FingerprintDataBrand__: never;

  /**
   * Whether all input and output files are known for this script, as well as
   * that of all of its transitive dependencies.
   */
  fullyTracked: boolean;

  /** E.g. linux, win32 */
  platform: NodeJS.Platform;

  /** E.g. x64 */
  arch: string;

  /** E.g. 16.7.0 */
  nodeVersion: string;

  /**
   * The shell command from the Wireit config.
   */
  command: string | undefined;

  /**
   * Extra arguments to pass to the command.
   */
  extraArgs: string[];

  /**
   * The "clean" setting from the Wireit config.
   *
   * This is included in the fingerprint because switching from "false" to "true"
   * could produce different output, so a re-run should be triggered even if
   * nothing else changed.
   */
  clean: boolean | 'if-file-deleted';

  // Must be sorted.
  files: {[packageDirRelativeFilename: string]: FileSha256HexDigest};

  /**
   * The "output" glob patterns from the Wireit config.
   *
   * This is included in the fingerprint because changing the output patterns
   * could produce different output when "clean" is true, and because it affects
   * which files get included in a cache entry.
   *
   * Note the undefined vs empty-array distinction is not meaningful here,
   * because both cases cause no files to be deleted, and the undefined case is
   * never cached anyway.
   */
  output: string[];

  // Must be sorted.
  dependencies: {
    [dependency: ScriptReferenceString]: FingerprintSha256HexDigest;
  };

  service:
    | {
        readyWhen: {
          lineMatches: string | undefined;
        };
      }
    | undefined;

  env: Record<string, string>;
}

/**
 * String serialization of a {@link FingerprintData}.
 */
export type FingerprintString = string & {
  __FingerprintStringBrand__: never;
};

/**
 * SHA256 hash hexadecimal digest of a file's content.
 */
export type FileSha256HexDigest = string & {
  __FileSha256HexDigestBrand__: never;
};

/**
 * SHA256 hash hexadecimal digest of a JSON-stringified fingerprint.
 */
type FingerprintSha256HexDigest = string & {
  __FingerprintSha256HexDigestBrand__: never;
};

/**
 * The fingerprint of a script. Converts lazily between string and data object
 * forms.
 */
export class Fingerprint {
  static fromString(string: FingerprintString): Fingerprint {
    const fingerprint = new Fingerprint();
    fingerprint.#str = string;
    return fingerprint;
  }

  /**
   * Generate the fingerprint data object for a script based on its current
   * configuration, input files, and the fingerprints of its dependencies.
   */
  static async compute(
    script: ScriptConfig,
    dependencyFingerprints: Array<[Dependency, Fingerprint]>,
  ): Promise<Result<Fingerprint, Failure>> {
    let allDependenciesAreFullyTracked = true;
    const filteredDependencyFingerprints: Array<
      [ScriptReferenceString, FingerprintSha256HexDigest]
    > = [];
    for (const [dep, depFingerprint] of dependencyFingerprints) {
      if (!dep.cascade) {
        // cascade: false means the fingerprint of the dependency isn't
        // directly inherited.
        continue;
      }
      if (!depFingerprint.data.fullyTracked) {
        allDependenciesAreFullyTracked = false;
      }
      filteredDependencyFingerprints.push([
        scriptReferenceToString(dep.config),
        depFingerprint.hash,
      ]);
    }

    let fileHashes: Array<[string, FileSha256HexDigest]>;
    if (script.files?.values.length) {
      const files = await glob(script.files.values, {
        cwd: script.packageDir,
        followSymlinks: true,
        // TODO(aomarks) This means that empty directories are not reflected in
        // the fingerprint, however an empty directory could modify the behavior
        // of a script. We should probably include empty directories; we'll just
        // need special handling when we compute the fingerprint, because there
        // is no hash we can compute.
        includeDirectories: false,
        // We must expand directories here, because we need the complete
        // explicit list of files to hash.
        expandDirectories: true,
        throwIfOutsideCwd: false,
      });
      // TODO(aomarks) Instead of reading and hashing every input file on every
      // build, use inode/mtime/ctime/size metadata (which is much faster to
      // read) as a heuristic to detect files that have likely changed, and
      // otherwise re-use cached hashes that we store in e.g.
      // ".wireit/<script>/hashes".
      const erroredFilePaths: string[] = [];
      fileHashes = await Promise.all(
        files.map(async (file): Promise<[string, FileSha256HexDigest]> => {
          const absolutePath = file.path;
          const hash = createHash('sha256');
          try {
            const stream = await createReadStream(absolutePath);
            for await (const chunk of stream) {
              hash.update(chunk as Buffer);
            }
          } catch (error) {
            // It's possible for a file to be deleted between the
            // time it is globbed and the time it is fingerprinted.
            const {code} = error as {code: string};
            if (code !== /* does not exist */ 'ENOENT') {
              throw error;
            }
            erroredFilePaths.push(absolutePath);
          }
          return [file.path, hash.digest('hex') as FileSha256HexDigest];
        }),
      );

      if (erroredFilePaths.length > 0) {
        return {
          ok: false,
          error: {
            type: 'failure',
            reason: 'input-file-deleted-unexpectedly',
            script: script,
            filePaths: erroredFilePaths,
          },
        };
      }
    } else {
      fileHashes = [];
    }

    const fullyTracked =
      // If any any dependency is not fully tracked, then we can't be either,
      // because we can't know if there was an undeclared input that this script
      // depends on.
      allDependenciesAreFullyTracked &&
      // A no-command script. Doesn't ever do anything itsef, so always fully
      // tracked.
      (script.command === undefined ||
        // A service. Fully tracked if we know its inputs. Can't produce output.
        (script.service !== undefined && script.files !== undefined) ||
        // A standard script. Fully tracked if we know both its inputs and
        // outputs.
        (script.files !== undefined && script.output !== undefined));

    const fingerprint = new Fingerprint();

    // Note: The order of all fields is important so that we can do fast string
    // comparison.
    const data: Omit<FingerprintData, '__FingerprintDataBrand__'> = {
      fullyTracked,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      command: script.command?.value,
      extraArgs: script.extraArgs ?? [],
      clean: script.clean,
      files: Object.fromEntries(
        fileHashes.sort(([aFile], [bFile]) => aFile.localeCompare(bFile)),
      ),
      output: script.output?.values ?? [],
      dependencies: Object.fromEntries(
        filteredDependencyFingerprints.sort(([aRef], [bRef]) =>
          aRef.localeCompare(bRef),
        ),
      ),
      service:
        script.service === undefined
          ? undefined
          : {
              readyWhen: {
                lineMatches: script.service.readyWhen.lineMatches?.toString(),
              },
            },
      env: script.env,
    };
    fingerprint.#data = data as FingerprintData;
    return {ok: true, value: fingerprint};
  }

  #str?: FingerprintString;
  #data?: FingerprintData;
  #hash?: FingerprintSha256HexDigest;

  get string(): FingerprintString {
    if (this.#str === undefined) {
      this.#str = JSON.stringify(this.#data!) as FingerprintString;
    }
    return this.#str;
  }

  get data(): FingerprintData {
    if (this.#data === undefined) {
      this.#data = JSON.parse(this.#str!) as FingerprintData;
    }
    return this.#data;
  }

  get hash(): FingerprintSha256HexDigest {
    if (this.#hash === undefined) {
      this.#hash = createHash('sha256')
        .update(this.string)
        .digest('hex') as FingerprintSha256HexDigest;
    }
    return this.#hash;
  }

  equal(other: Fingerprint): boolean {
    return this.string === other.string;
  }
}
