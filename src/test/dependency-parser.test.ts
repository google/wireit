/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {
  parseDependency,
  type ParsedPackage,
  type ParsedScript,
} from '../analysis/dependency-parser.js';
import type {DiagnosticWithoutFile} from '../error.js';

const test = suite<object>();

const cases: Array<
  [
    /**
     * Dependency specifier, e.g. "./pkg#scr".
     */
    string,

    /**
     * A string the same length as the dependency specifier, where each
     * character represents how we should interpret the corresponding character
     * from the dependency, with P = package, S = script, E = error, and
     * anything else is ignored (e.g. "PPPPP_SSS"). This way we can clearly
     * annotate the expected character ranges for each parsed component.
     */
    string,
    (
      | {
          package: ParsedPackage;
          script: ParsedScript;
          inverted?: true;
        }
      | Omit<DiagnosticWithoutFile, 'location'>
    ),
  ]
> = [
  [
    '',
    '',
    {
      severity: 'error',
      message: 'Dependency cannot be empty',
    },
  ],
  [
    './pkg#scr',
    'PPPPP_SSS',
    {
      package: {kind: 'path', path: './pkg'},
      script: {kind: 'name', name: 'scr'},
    },
  ],
  [
    'scr',
    'SSS',
    {
      package: {kind: 'this'},
      script: {kind: 'name', name: 'scr'},
    },
  ],
  [
    '#scr',
    '_SSS',
    {
      severity: 'error',
      message: 'Package specifier cannot be empty',
    },
  ],
  [
    './pkg#scr#',
    'PPPPP_SSSE',
    {
      severity: 'error',
      message: 'Unexpected additional delimiter "#"',
    },
  ],
  [
    './pkg##',
    'PPPPP_E',
    {
      severity: 'error',
      message: 'Unexpected additional delimiter "#"',
    },
  ],
  [
    './pkg',
    'EEEEE',
    {
      severity: 'error',
      message:
        `Cross-package dependency must use syntax ` +
        `"<relative-path>#<script-name>", but there's no ` +
        `"#" character in "./pkg".`,
    },
  ],
  [
    String.raw`./\#pkg\##scr`,
    String.raw`PPPPPPPPP_SSS`,
    {
      package: {kind: 'path', path: './#pkg#'},
      script: {kind: 'name', name: 'scr'},
    },
  ],
  [
    String.raw`./pkg#\#scr\#`,
    String.raw`PPPPP_SSSSSSS`,
    {
      package: {kind: 'path', path: './pkg'},
      script: {kind: 'name', name: '#scr#'},
    },
  ],
  [
    String.raw`\./scr`,
    String.raw`_SSSSS`,
    {
      package: {kind: 'this'},
      script: {kind: 'name', name: './scr'},
    },
  ],
  [
    '!./pkg#scr',
    '_PPPPP_SSS',
    {
      inverted: true,
      package: {kind: 'path', path: './pkg'},
      script: {kind: 'name', name: 'scr'},
    },
  ],
  [
    '!scr',
    '_SSS',
    {
      inverted: true,
      package: {kind: 'this'},
      script: {kind: 'name', name: 'scr'},
    },
  ],
  [
    '!!scr',
    '_SSSS',
    {
      inverted: true,
      package: {kind: 'this'},
      script: {kind: 'name', name: '!scr'},
    },
  ],
  [
    String.raw`\!scr`,
    String.raw`_SSSS`,
    {
      package: {kind: 'this'},
      script: {kind: 'name', name: '!scr'},
    },
  ],
  [
    './pkg:scr',
    'PPPPP_SSS',
    {
      package: {kind: 'path', path: './pkg'},
      script: {kind: 'name', name: 'scr'},
    },
  ],
  [
    './pkg:foo#scr',
    'PPPPPPPPP_SSS',
    {
      package: {
        kind: 'path',
        path: './pkg:foo',
      },
      script: {kind: 'name', name: 'scr'},
    },
  ],
  [
    String.raw`./pkg:foo\#scr`,
    String.raw`PPPPP_SSSSSSSS`,
    {
      package: {kind: 'path', path: './pkg'},
      script: {kind: 'name', name: 'foo#scr'},
    },
  ],
  [
    String.raw`./pkg:foo\##scr`,
    String.raw`PPPPPPPPPPP_SSS`,
    {
      package: {kind: 'path', path: './pkg:foo#'},
      script: {kind: 'name', name: 'scr'},
    },
  ],
  [
    '#foo',
    '_SSS',
    {
      severity: 'error',
      message: 'Package specifier cannot be empty',
    },
  ],
  [
    './pkg:<workspaces>',
    'PPPPP_EEEEEEEEEEEE',
    {
      severity: 'error',
      message: 'Unknown special script "workspaces"',
    },
  ],
  [
    './pkg#<>',
    'PPPPP_EE',
    {
      severity: 'error',
      message: 'Unexpected ">". Escape as "\\>" if you meant it literally.',
    },
  ],
  [
    '<>',
    'EE',
    {
      severity: 'error',
      message: 'Unexpected ">". Escape as "\\>" if you meant it literally.',
    },
  ],
  [
    '<workspaces>#scr',
    'PPPPPPPPPPPP_SSS',
    {
      package: {kind: 'workspaces'},
      script: {kind: 'name', name: 'scr'},
    },
  ],
  [
    '<dependencies>#scr',
    'PPPPPPPPPPPPPP_SSS',
    {
      package: {kind: 'dependencies'},
      script: {kind: 'name', name: 'scr'},
    },
  ],
  [
    '<dependencies>#<this>',
    'PPPPPPPPPPPPPP_SSSSSS',
    {
      package: {kind: 'dependencies'},
      script: {kind: 'this'},
    },
  ],
  [
    String.raw`./pkg\*#scr\*`,
    String.raw`PPPPPPP_SSSSS`,
    {
      package: {kind: 'path', path: './pkg*'},
      script: {kind: 'name', name: 'scr*'},
    },
  ],
  [
    String.raw`./pkg\{foo,bar}#scr\{foo,bar}`,
    String.raw`PPPPPPPPPPPPPPP_SSSSSSSSSSSSS`,
    {
      package: {
        kind: 'path',
        path: './pkg{foo,bar}',
      },
      script: {
        kind: 'name',
        name: 'scr{foo,bar}',
      },
    },
  ],
  [
    'npm-package#scr',
    'PPPPPPPPPPP_SSS',
    {
      package: {
        kind: 'npm',
        package: 'npm-package',
      },
      script: {kind: 'name', name: 'scr'},
    },
  ],
  [
    'package#scr:dee:doo',
    'PPPPPPP_SSSSSSSSSSS',
    {
      package: {
        kind: 'npm',
        package: 'package',
      },
      script: {
        kind: 'name',
        name: 'scr:dee:doo',
      },
    },
  ],
] as const;

for (const [dependency, rangeString, valueOrError] of cases) {
  test(dependency, () => {
    const actual = parseDependency(dependency);
    const ranges = extractRanges(rangeString);
    let expected: ReturnType<typeof parseDependency>;
    if ('severity' in valueOrError) {
      expected = {
        ok: false,
        error: {
          ...valueOrError,
          location: {range: ranges.E},
        },
      };
    } else {
      expected = {
        ok: true,
        value: {
          ...valueOrError,
          inverted: valueOrError.inverted ?? false,
          package: {...valueOrError.package, range: ranges.P},
          script: {...valueOrError.script, range: ranges.S},
        },
      };
    }
    assert.equal(actual, expected);
  });
}

function extractRanges(str: string) {
  const result = {
    S: {offset: 0, length: 0},
    P: {offset: 0, length: 0},
    E: {offset: 0, length: 0},
  };
  for (const match of str.matchAll(/([SPE])\1*/g)) {
    result[match[1] as 'S' | 'P' | 'E'] = {
      offset: match.index,
      length: match[0].length,
    };
  }
  return result;
}

test('extractRanges', () => {
  assert.equal(extractRanges('PPP_SS_E'), {
    P: {offset: 0, length: 3},
    S: {offset: 4, length: 2},
    E: {offset: 7, length: 1},
  });

  assert.equal(extractRanges(''), {
    P: {offset: 0, length: 0},
    S: {offset: 0, length: 0},
    E: {offset: 0, length: 0},
  });
});

test.run();
