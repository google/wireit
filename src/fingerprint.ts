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

export type ComputeFingerprintResult = {
  fingerprint: Fingerprint;
  notFullyTrackedReason: NotFullyTrackedReason | undefined;
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
  ): Promise<ComputeFingerprintResult> {
    let notFullyTrackedDep: ScriptReferenceString | undefined = undefined;
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
        if (notFullyTrackedDep === undefined) {
          notFullyTrackedDep = scriptReferenceToString(dep.config);
        }
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
      fileHashes = await Promise.all(
        files.map(async (file): Promise<[string, FileSha256HexDigest]> => {
          const absolutePath = file.path;
          const hash = createHash('sha256');
          for await (const chunk of await createReadStream(absolutePath)) {
            hash.update(chunk as Buffer);
          }
          return [file.path, hash.digest('hex') as FileSha256HexDigest];
        }),
      );
    } else {
      fileHashes = [];
    }

    const notFullyTrackedReason: NotFullyTrackedReason | undefined = (() => {
      // If any any dependency is not fully tracked, then we can't be either,
      // because we can't know if there was an undeclared input that this script
      // depends on.
      if (notFullyTrackedDep !== undefined) {
        return {
          name: 'dependency not fully tracked',
          dependency: notFullyTrackedDep,
        };
      }
      // A no-command script. Doesn't ever do anything itsef, so always fully
      // tracked.
      if (script.command === undefined) {
        return undefined;
      }
      // A service. Always fully tracked. No 'files' means that we
      // assume that it writes no files. Can't produce output.
      if (script.service !== undefined) {
        return undefined;
      }

      if (script.files === undefined) {
        return {name: 'no files field'};
      }
      // A standard script. Fully tracked if we know both its inputs and
      // outputs.
      if (script.output === undefined) {
        return {name: 'no output field'};
      }
      return undefined;
    })();
    const fullyTracked = notFullyTrackedReason === undefined;

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
    return {fingerprint, notFullyTrackedReason};
  }

  #str?: FingerprintString;
  #data?: FingerprintData;
  #hash?: FingerprintSha256HexDigest;

  get string(): FingerprintString {
    if (this.#str === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.#str = JSON.stringify(this.#data!) as FingerprintString;
    }
    return this.#str;
  }

  get data(): FingerprintData {
    if (this.#data === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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

  requiresRebuild(previous: Fingerprint | undefined): boolean {
    // If we're not fully tracked, we always need to rebuild.
    if (!this.data.fullyTracked) {
      return true;
    }
    // If we don't have a previous fingerprint, we need to rebuild.
    if (previous === undefined) {
      return true;
    }
    // Otherwise, we need to rebuild if the fingerprint changed.
    return !this.equal(previous);
  }

  difference(previous: Fingerprint): Difference | undefined {
    // Do a string comparison first, because it's much faster than
    // checking field by field;
    if (this.equal(previous)) {
      return undefined;
    }
    if (this.data.platform !== previous.data.platform) {
      return {
        name: 'environment',
        field: 'platform',
        previous: this.data.platform,
        current: previous.data.platform,
      };
    }
    if (this.data.arch !== previous.data.arch) {
      return {
        name: 'environment',
        field: 'arch',
        previous: this.data.arch,
        current: previous.data.arch,
      };
    }
    if (this.data.nodeVersion !== previous.data.nodeVersion) {
      return {
        name: 'environment',
        field: 'nodeVersion',
        previous: this.data.nodeVersion,
        current: previous.data.nodeVersion,
      };
    }
    if (this.data.command !== previous.data.command) {
      return {
        name: 'config',
        field: 'command',
        previous: this.data.command,
        current: previous.data.command,
      };
    }
    if (this.data.extraArgs.join(' ') !== previous.data.extraArgs.join(' ')) {
      return {
        name: 'config',
        field: 'extraArgs',
        previous: this.data.extraArgs,
        current: previous.data.extraArgs,
      };
    }
    if (this.data.clean !== previous.data.clean) {
      return {
        name: 'config',
        field: 'clean',
        previous: this.data.clean,
        current: previous.data.clean,
      };
    }
    if (this.data.output.join(' ') !== previous.data.output.join(' ')) {
      return {
        name: 'config',
        field: 'output',
        previous: this.data.output,
        current: previous.data.output,
      };
    }
    if (
      this.data.service?.readyWhen.lineMatches !==
      previous.data.service?.readyWhen.lineMatches
    ) {
      return {
        name: 'config',
        field: 'service',
        previous: this.data.service,
        current: previous.data.service,
      };
    }
    if (JSON.stringify(this.data.env) !== JSON.stringify(previous.data.env)) {
      return {
        name: 'config',
        field: 'env',
        previous: this.data.env,
        current: previous.data.env,
      };
    }
    const thisFiles = new Set(Object.keys(this.data.files));
    const previousFiles = new Set(Object.keys(previous.data.files));
    for (const path of thisFiles) {
      if (!previousFiles.has(path)) {
        return {name: 'file added', path};
      }
    }
    for (const path of previousFiles) {
      if (!thisFiles.has(path)) {
        return {name: 'file removed', path};
      }
    }
    for (const path of thisFiles) {
      if (this.data.files[path] !== previous.data.files[path]) {
        return {name: 'file changed', path};
      }
    }
    const thisDependencies = new Set(
      Object.keys(this.data.dependencies) as ScriptReferenceString[],
    );
    const previousDependencies = new Set(
      Object.keys(previous.data.dependencies) as ScriptReferenceString[],
    );
    for (const dependency of thisDependencies) {
      if (!previousDependencies.has(dependency)) {
        return {
          name: 'dependency changed',
          script: dependency,
        };
      }
    }
    for (const dependency of previousDependencies) {
      if (!thisDependencies.has(dependency)) {
        return {
          name: 'dependency removed',
          script: dependency,
        };
      }
    }
    for (const dependency of thisDependencies) {
      if (
        this.data.dependencies[dependency] !==
        previous.data.dependencies[dependency]
      ) {
        return {
          name: 'dependency changed',
          script: dependency,
        };
      }
    }
    throw new Error(
      `Internal error: fingerprints different but no difference was found.\n    current: ${this.string}\n    previous: ${previous.string}`,
    );
  }
}

export type NotFullyTrackedReason =
  | {name: 'no files field'}
  | {name: 'no output field'}
  | {
      name: 'dependency not fully tracked';
      dependency: ScriptReferenceString;
    };

export type Difference =
  | {
      name: 'environment';
      field: 'platform' | 'arch' | 'nodeVersion';
      previous: string;
      current: string;
    }
  | {
      name: 'config';
      field: 'command' | 'extraArgs' | 'clean' | 'output' | 'service' | 'env';
      previous: unknown;
      current: unknown;
    }
  | {name: 'file added'; path: string}
  | {name: 'file removed'; path: string}
  | {name: 'file changed'; path: string}
  | {name: 'dependency removed'; script: ScriptReferenceString}
  | {name: 'dependency added'; script: ScriptReferenceString}
  | {name: 'dependency changed'; script: ScriptReferenceString};
