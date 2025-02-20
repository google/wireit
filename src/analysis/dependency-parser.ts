/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {DiagnosticWithoutFile, Range, Result} from '../error.js';

/**
 * Parse a Wireit dependency specifier.
 *
 * A Wireit dependency specifier is what appears in a
 * `"wireit.<script>.dependencies"` array in a `package.json` file, which
 * controls which script must run before the current one.
 *
 *
 * ### QUICK EXAMPLES
 *
 * |                           |                                                                   |
 * |---------------------------|-------------------------------------------------------------------|
 * | `build`                   | The script named `build` in the current package.                  |
 * | `../foo#build`            | The script named `build` in the package located at `../foo`.      |
 * | `my-npm-package#build`    | The script named `build` in the package named `my-npm-package`.   |
 * | `<workspaces>#build`      | The script named `build` in all workspaces of the current package.|
 * | `<dependencies>#<this>`   | The script named the same as the current script in all npm dependencies sharing a common workspace root. |
 *
 *
 * ### GENERAL FORMS
 *
 * |                           |                                                                   |
 * |---------------------------|-------------------------------------------------------------------|
 * | `script`                  | Script only. Package is implicitly the current one.               |
 * | `package#script`          | Package and script with preferred `#` delimiter.                  |
 * | `./path:script`           | Package and script with limited legacy `:` delimiter.             |
 *
 *
 * ### PACKAGE SPECIFIERS
 *
 * |                           |                                                                   |
 * |---------------------------|-------------------------------------------------------------------|
 * | `./path/to/pkg`           | A package path (identified by the leading `.`)                    |
 * | `some-npm-package`        | An npm package.                                                   |
 * | `<this>`                  | The current package.                                              |
 * | `<workspaces>`            | All workspaces of the current package.                            |
 * | `<dependencies>`          | All dependencies of the current package sharing a common workspace root. |
 *
 *
 * ### SCRIPT SPECIFIERS
 *
 * |                           |                                                                   |
 * |---------------------------|-------------------------------------------------------------------|
 * | `build`                   | A script name.                                                    |
 * | `<this>`                  | The current script.                                               |
 *
 *
 * ### INVERSION
 *
 * A dependency specifier can be inverted by prefixing it with a `!`. This means
 * that any matching scripts will be excluded from the preceding (but not
 * following) matching scripts.
 *
 * |                           |                                                                   |
 * |---------------------------|-------------------------------------------------------------------|
 * | `<dependencies>:build`    | All dependency "build" scripts ...                                |
 * | `../broken:build`         | ... except for the specific one in the "broken" folder.           |
 *
 *
 * ### ESCAPING
 *
 * The following characters have special meaning, and must be escaped with `\`
 * if meant literally:
 *
 * |                           |                                                                   |
 * |---------------------------|-------------------------------------------------------------------|
 * | `\`                       | Escape character.                                                 |
 * | `#`                       | Delimiter between package and script.                             |
 * | `<`                       | Start of a _special_ like `<workspaces>`.                         |
 * | `>`                       | End of a special.                                                 |
 *
 * The following characters have special meaning only at the beginning of the
 * dependency string, and must be escaped with `\` if meant literally:
 *
 * |                           |                                                                   |
 * |---------------------------|-------------------------------------------------------------------|
 * | `!`                       | Inverts the dependency.                                           |
 * | `.`                       | A package path.                                                   |
 *
 * The following character has special meaning only in the legacy form
 * `./path/to/pkg:script`, and must be escaped with `\` if meant literally:
 *
 * |                           |                                                                   |
 * |---------------------------|-------------------------------------------------------------------|
 * | `:`                       | Old delimiter between package and script.                         |
 */

export function parseDependency(
  dependency: string,
): Result<ParsedDependency, DiagnosticWithoutFile> {
  const result = new DependencyParser(dependency).parse();
  return result;
}

/**
 * A parsed wireit dependency string. See {@link parseDependency}.
 */
export interface ParsedDependency {
  package: ParsedPackageWithRange;
  script: ParsedScriptWithRange;
  inverted: boolean;
}

export type ParsedPackageWithRange = ParsedPackage & {range: Range};
export type ParsedPackage =
  | PackagePath
  | PackageNpm
  | PackageThis
  | PackageWorkspaces
  | PackageDependencies;

export type ParsedScriptWithRange = ParsedScript & {range: Range};
export type ParsedScript = ScriptName | ScriptThis;

export interface PackagePath {
  kind: 'path';
  path: string;
}

export interface PackageNpm {
  kind: 'npm';
  package: string;
}

export interface PackageThis {
  kind: 'this';
}

export interface PackageWorkspaces {
  kind: 'workspaces';
}

export interface PackageDependencies {
  kind: 'dependencies';
}

export interface ScriptName {
  kind: 'name';
  name: string;
}

export interface ScriptThis {
  kind: 'this';
}

type Segment = StringSegment | SpecialSegment;

type StringSegment = {
  kind: 'string';
  string: string;
  // Note this can be range can be longer than the length of `string`, since it
  // includes escapes.
  range: Range;
};

type SpecialSegment = {
  kind: 'special';
  special: string;
  range: Range;
};

const PERIOD = '.';
const HASH = '#';
const BACKSLASH = '\\';
const EXCLAMATION = '!';
const COLON = ':';
const LT = '<';
const GT = '>';

class DependencyParser {
  readonly #str: string;
  readonly #len: number;
  #pos = 0;

  constructor(str: string) {
    this.#str = str;
    this.#len = str.length;
  }

  #peek(offset = 0): string | undefined {
    return this.#str[this.#pos + offset];
  }

  #skip(num = 1): void {
    this.#pos += num;
  }

  #done(): boolean {
    return this.#pos === this.#len;
  }

  #error(
    message: string,
    range: Range,
  ): {ok: false; error: DiagnosticWithoutFile} {
    return {
      ok: false,
      error: {
        severity: 'error',
        message,
        location: {range: range},
      },
    };
  }

  parse(): Result<ParsedDependency, DiagnosticWithoutFile> {
    if (this.#done()) {
      return this.#error('Dependency cannot be empty', {offset: 0, length: 0});
    }

    // "!" and "." have special meaning only at the beginning of the dependency.
    let inverted = false;
    let startsWithPeriod = false;
    const firstChar = this.#peek();
    if (firstChar === EXCLAMATION) {
      inverted = true;
      this.#skip();
    } else if (firstChar === PERIOD) {
      startsWithPeriod = true;
    } else if (firstChar === BACKSLASH) {
      const secondChar = this.#peek(1);
      if (secondChar === EXCLAMATION || secondChar === PERIOD) {
        this.#skip();
      }
      // Otherwise, let the next section handle the escape.
    }

    // It is convenient in this code to refer to both scripts and packages as
    // "segments", because they are parsed very similarly, and because the first
    // one we encounter could turn out to be either a script or a package
    // depending on whether a delimiter shows up later.

    const firstSegment = this.#parseSegment(startsWithPeriod);
    if (!firstSegment.ok) {
      return firstSegment;
    }

    if (this.#done()) {
      // There was only one segment.
      if (startsWithPeriod) {
        // E.g. "../foo".
        return this.#error(
          `Cross-package dependency must use syntax "<relative-path>#<script-name>", ` +
            `but there's no "#" character in ${JSON.stringify(this.#str)}.`,
          {
            offset: 0,
            length: this.#len,
          },
        );
      }
      const script = this.#interpretSegmentAsScript(firstSegment.value);
      if (!script.ok) {
        return script;
      }
      // E.g. "build:tsc"
      return {
        ok: true,
        value: {
          package: {
            kind: 'this',
            range: {offset: 0, length: 0},
          },
          script: script.value,
          inverted,
        },
      };
    }

    const pkg = this.#interpretSegmentAsPackage(firstSegment.value);
    if (!pkg.ok) {
      return pkg;
    }

    this.#skip(); // Skip the delimiter.

    const secondSegment = this.#parseSegment(false);
    if (!secondSegment.ok) {
      return secondSegment;
    }
    if (!this.#done()) {
      // E.g. "pkg#script#huh"
      return this.#error(`Unexpected additional delimiter "${this.#peek()}"`, {
        offset: this.#pos,
        length: 1,
      });
    }

    const script = this.#interpretSegmentAsScript(secondSegment.value);
    if (!script.ok) {
      return script;
    }
    return {
      ok: true,
      value: {
        package: pkg.value,
        script: script.value,
        inverted,
      },
    };
  }

  /**
   * Parse a "segment", which can be either a package or a script depending on
   * its position.
   */
  #parseSegment(
    inPathPosition: boolean,
  ): Result<Segment, DiagnosticWithoutFile> {
    if (this.#peek() === LT) {
      // For now we only support specials when they comprise the entire segment.
      return this.#parseSpecial();
    }
    const start = this.#pos;
    let string = '';
    let rawLength = 0;
    while (!this.#done()) {
      const cur = this.#peek()!;
      if (cur === HASH) {
        break;
      }
      if (
        inPathPosition &&
        cur === COLON &&
        !this.#lookAheadForUnescapedHash()
      ) {
        // Support the old ":" delimiter (e.g. "./pkg:scr"), but only if we're
        // not using the new "#" delimiter (e.g. "./pkg:foo#scr"), in which case
        // treat ":" literally.
        break;
      }
      if (cur === LT) {
        // Reserve "<" in all positions, even though we only handle specials
        // when they are the whole segment, because it is conceivable in the
        // future that we may want to support specials appearing next to static
        // strings or other specials, plus it seems simpler to understand if we
        // are consistent with when you need to escape the special characters.
        return this.#error(
          String.raw`Unexpected "<". Escape as "\<" if you meant it literally.`,
          {offset: this.#pos, length: 1},
        );
      }
      if (cur === BACKSLASH) {
        const next = this.#peek(1);
        if (next === undefined) {
          return this.#error('Trailing backslash', {offset: start, length: 1});
        }
        string += next;
        this.#skip(2);
        rawLength += 2;
        continue;
      }
      string += cur;
      rawLength += 1;
      this.#skip();
    }
    return {
      ok: true,
      value: {
        kind: 'string',
        string,
        range: {
          offset: start,
          length: rawLength,
        },
      },
    };
  }

  #parseSpecial(): Result<SpecialSegment, DiagnosticWithoutFile> {
    const start = this.#pos;
    this.#skip(); // Assume LT
    let special = '';
    while (!this.#done()) {
      const cur = this.#peek()!;
      if (cur === GT) {
        if (special.length === 0) {
          return this.#error(
            String.raw`Unexpected ">". Escape as "\>" if you meant it literally.`,
            {offset: start, length: 2},
          );
        }
        this.#skip();
        return {
          ok: true,
          value: {
            kind: 'special',
            special,
            range: {
              offset: start,
              length: special.length + 2,
            },
          },
        };
      } else {
        special += cur;
        this.#skip();
      }
    }
    return this.#error(`Unexpected end of string in <special>`, {
      offset: this.#pos,
      length: 1,
    });
  }

  #interpretSegmentAsPackage(
    segment: Segment,
  ): Result<ParsedPackageWithRange, DiagnosticWithoutFile> {
    if (segment.kind === 'string') {
      if (segment.string[0] === PERIOD) {
        return {
          ok: true,
          value: {
            kind: 'path',
            path: segment.string,
            range: segment.range,
          },
        };
      } else if (segment.string.length !== 0) {
        return {
          ok: true,
          value: {
            kind: 'npm',
            package: segment.string,
            range: segment.range,
          },
        };
      } else {
        return this.#error('Package specifier cannot be empty', segment.range);
      }
    }
    const special = segment.special;
    if (
      special === 'this' ||
      special === 'workspaces' ||
      special === 'dependencies'
    ) {
      return {
        ok: true,
        value: {
          kind: special,
          range: segment.range,
        },
      };
    }
    return this.#error(`Unknown special package "${special}"`, segment.range);
  }

  #interpretSegmentAsScript(
    segment: Segment,
  ): Result<ParsedScriptWithRange, DiagnosticWithoutFile> {
    if (segment.kind === 'string') {
      if (segment.string.length === 0) {
        return this.#error(
          `Cross-package dependency must use syntax "<relative-path>#<script-name>", ` +
            `but there's no script name in ${JSON.stringify(this.#str)}.`,
          {offset: 0, length: this.#len},
        );
      }
      return {
        ok: true,
        value: {
          kind: 'name',
          name: segment.string,
          range: segment.range,
        },
      };
    }
    const special = segment.special;
    if (special === 'this') {
      return {
        ok: true,
        value: {
          kind: 'this',
          range: segment.range,
        },
      };
    }
    return this.#error(`Unknown special script "${special}"`, segment.range);
  }

  #lookAheadForUnescapedHash(): boolean {
    for (let i = this.#pos + 1; i < this.#str.length; i++) {
      const char = this.#str[i];
      if (char === HASH) {
        return true;
      } else if (char === BACKSLASH) {
        i++; // Skip an additional character (since it's escaped).
      }
    }
    return false;
  }
}
