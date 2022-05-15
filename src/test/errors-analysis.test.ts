/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import * as pathlib from 'path';
import {timeout} from './util/uvu-timeout.js';
import {WireitTestRig} from './util/test-rig.js';
import {NODE_MAJOR_VERSION} from './util/node-version.js';
import {removeAciiColors} from './util/colors.js';
import {IS_WINDOWS} from '../util/windows.js';

const test = suite<{rig: WireitTestRig}>();

// The npm version that ships with with Node 14 produces a bunch of additional
// logs when running a script, so we need to use the less strict assert.match.
// assert.equal gives a better error message.
const assertScriptOutputEquals = (
  actual: string,
  expected: string,
  message?: string
) => {
  const assertOutputEqualish =
    NODE_MAJOR_VERSION < 16 ? assert.match : assert.equal;

  actual = removeAciiColors(actual.trim());
  expected = expected.trim();
  if (actual !== expected) {
    console.log(`Copy-pastable output:\n${actual}`);
    for (let i = 0; i < actual.length; i++) {
      if (actual[i] !== expected[i]) {
        console.log(`${i}: ${actual[i]} !== ${expected[i]}`);
        break;
      }
    }
  }
  assertOutputEqualish(actual, expected, message);
};

test.before.each(async (ctx) => {
  try {
    ctx.rig = new WireitTestRig();
    await ctx.rig.setup();
  } catch (error) {
    // Uvu has a bug where it silently ignores failures in before and after,
    // see https://github.com/lukeed/uvu/issues/191.
    console.error('uvu before error', error);
    process.exit(1);
  }
});

test.after.each(async (ctx) => {
  try {
    await ctx.rig.cleanup();
  } catch (error) {
    // Uvu has a bug where it silently ignores failures in before and after,
    // see https://github.com/lukeed/uvu/issues/191.
    console.error('uvu after error', error);
    process.exit(1);
  }
});

test(
  'wireit section is not an object',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: [],
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:5:13 Expected an object, but was array.
      "wireit": []
                ~~
❌ package.json:3:10 This script is configured to run wireit but it has no config in the wireit section of this package.json file
        "a": "wireit"
             ~~~~~~~~`
    );
  })
);

test(
  'wireit config is not an object',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: [],
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:6:10 Expected an object, but was array.
        "a": []
             ~~
❌ package.json:3:10 This script is configured to run wireit but it has no config in the wireit section of this package.json file
        "a": "wireit"
             ~~~~~~~~`
    );
  })
);

test(
  'wireit config but no entry in scripts section',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['b'],
          },
          b: {
            dependencies: [],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:11:5 Script "b" not found in the scripts section of this package.json.
        "b": {
        ~~~`
    );
  })
);

test(
  'dependencies is not an array',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: {},
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:7:23 Expected an array, but was object.
          "dependencies": {}
                          ~~`
    );
  })
);

test(
  'dependency is not a string',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: [[]],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:8:9 Expected a string or object, but was array.
            []
            ~~`
    );
  })
);

test(`dependencies.script is not a string (object form)`, async ({rig}) => {
  await rig.write('package.json', {
    scripts: {
      a: 'wireit',
    },
    wireit: {
      a: {
        dependencies: [
          {
            script: [],
          },
        ],
      },
    },
  });
  const execResult = rig.exec(`npm run a`);
  const done = await execResult.exit;
  assert.equal(done.code, 1);
  assertScriptOutputEquals(
    done.stderr,
    `
❌ package.json:9:21 Expected a string, but was array.
              "script": []
                        ~~`
  );
});

test(
  'dependency is empty or blank',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: [' '],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:8:9 Expected this field to be nonempty
            " "
            ~~~`
    );
  })
);

test(`dependencies.script is empty or blank (object form)`, async ({rig}) => {
  await rig.write('package.json', {
    scripts: {
      a: 'wireit',
      1: 'wireit',
    },
    wireit: {
      a: {
        command: 'true',
        dependencies: [
          {
            script: '',
          },
        ],
      },
      1: {
        command: 'true',
      },
    },
  });
  const execResult = rig.exec(`npm run a`);
  const done = await execResult.exit;
  assert.equal(done.code, 1);
  assertScriptOutputEquals(
    done.stderr,
    `
❌ package.json:14:21 Expected this field to be nonempty
              "script": ""
                        ~~`
  );
});

test(`dependencies.script is missing (object form)`, async ({rig}) => {
  await rig.write('package.json', {
    scripts: {
      a: 'wireit',
      1: 'wireit',
    },
    wireit: {
      a: {
        command: 'true',
        dependencies: [{}],
      },
      1: {
        command: 'true',
      },
    },
  });
  const execResult = rig.exec(`npm run a`);
  const done = await execResult.exit;
  assert.equal(done.code, 1);
  assertScriptOutputEquals(
    done.stderr,
    `
❌ package.json:13:9 Dependency object must set a "script" property.
            {}
            ~~`
  );
});

test(
  'command is not a string',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: [],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:7:18 Expected a string, but was array.
          "command": []
                     ~~`
    );
  })
);

test(
  'command is empty or blank',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: '',
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:7:18 Expected this field to be nonempty
          "command": ""
                     ~~`
    );
  })
);

test(
  'files is not an array',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            files: {},
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:8:16 Expected an array, but was object.
          "files": {}
                   ~~`
    );
  })
);

test(
  'file item is not a string',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            files: [0],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:9:9 Expected a string, but was number.
            0
            ~`
    );
  })
);

test(
  'file item is empty or blank',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            files: [''],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:9:9 Expected this field to be nonempty
            ""
            ~~`
    );
  })
);

test(
  'output is not an array',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            output: {},
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:8:17 Expected an array, but was object.
          "output": {}
                    ~~`
    );
  })
);

test(
  'output item is not a string',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            output: [0],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:9:9 Expected a string, but was number.
            0
            ~`
    );
  })
);

test(
  'output item is empty or blank',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            output: [' \t\n '],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:9:9 Expected this field to be nonempty
            " \\t\\n "
            ~~~~~~~~`
    );
  })
);

test(
  'clean is not a boolean or "if-file-deleted"',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            clean: 0,
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:8:16 The "clean" property must be either true, false, or "if-file-deleted".
          "clean": 0
                   ~`
    );
  })
);

test(
  'packageLocks is not an array',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            packageLocks: 0,
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:8:23 Expected an array, but was number.
          "packageLocks": 0
                          ~`
    );
  })
);

test(
  'packageLocks item is not a string',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            packageLocks: [0],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:9:9 Expected a string, but was number.
            0
            ~`
    );
  })
);

test(
  'packageLocks item is empty or blank',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            packageLocks: [' '],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:9:9 Expected this field to be nonempty
            " "
            ~~~`
    );
  })
);

test(
  'packageLocks item is not a filename',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            packageLocks: ['../package-lock.json'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:9:9 A package lock must be a filename, not a path
            "../package-lock.json"
            ~~~~~~~~~~~~~~~~~~~~~~`
    );
  })
);

test(
  'missing dependency',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['missing'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:8:9 Cannot find script named "missing" in package "${rig.temp}"
            "missing"
            ~~~~~~~~~`
    );
  })
);

test(
  'missing cross package dependency',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['./child:missing'],
          },
        },
      },
      'child/package.json': {
        scripts: {},
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:8:18 Cannot find script named "missing" in package "${rig.resolve(
        'child'
      )}"
            "./child:missing"
                     ~~~~~~~`
    );
  })
);

test(
  'missing cross package dependency (object form)',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: [{script: './child:missing'}],
          },
        },
      },
      'child/package.json': {
        scripts: {},
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:9:30 Cannot find script named "missing" in package "${rig.resolve(
        'child'
      )}"
              "script": "./child:missing"
                                 ~~~~~~~`
    );
  })
);

test(
  'missing same-package dependency with colon in name',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['test:missing'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:8:9 Cannot find script named "test:missing" in package "${rig.temp}"
            "test:missing"
            ~~~~~~~~~~~~~~`
    );
  })
);
test(
  'missing cross package dependency with complicated escaped names',
  timeout(async ({rig}) => {
    // This test writes a file with a name that windows can't handle.
    if (IS_WINDOWS) {
      return;
    }
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['./ch\t\\ ild:mis\t\\ sing'],
          },
        },
      },
      'ch\t\\ ild/package.json': {
        scripts: {},
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      String.raw`
❌ package.json:8:23 Cannot find script named "mis\t\\ sing" in package "${rig.resolve(
        'ch\t\\ ild'
      )}"
            "./ch\t\\ ild:mis\t\\ sing"
                          ~~~~~~~~~~~~`
    );
  })
);

test(
  'cross-package dependency with complicated escaped name leads to directory without package.json',
  timeout(async ({rig}) => {
    await rig.write({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['../b\t\\ ar:b'],
          },
        },
      },
    });
    const result = rig.exec('npm run a', {cwd: 'foo'});
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      String.raw`
❌ package.json:8:10 package.json file missing: "${rig.resolve(
        'b\t\\ ar/package.json'
      )}"
            "../b\t\\ ar:b"
             ~~~~~~~~~~~`
    );
  })
);

test(
  'duplicate dependency',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'true',
        },
        wireit: {
          a: {
            dependencies: ['b', 'b'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:10:9 This dependency is listed multiple times
            "b"
            ~~~

    package.json:9:9 The dependency was first listed here.
                "b",
                ~~~`
    );
  })
);

test(
  'script command is not wireit',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'not-wireit',
        },
        wireit: {
          a: {
            dependencies: ['b'],
          },
          b: {
            command: 'true',
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:4:10 This command should just be "wireit", as this script is configured in the wireit section.
        "b": "not-wireit"
             ~~~~~~~~~~~~

    package.json:12:5 The wireit config is here.
            "b": {
            ~~~
`.trimStart()
    );
  })
);

test(
  'script is wireit but has no wireit config',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {},
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:3:10 This script is configured to run wireit but it has no config in the wireit section of this package.json file
        "a": "wireit"
             ~~~~~~~~
`
    );
  })
);

test(
  'script has no command and no dependencies',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {},
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:6:5 A wireit config must set at least one of "command" or "dependencies", otherwise there is nothing for wireit to do.
        "a": {}
        ~~~`
    );
  })
);

test(
  "cross-package dependency doesn't have a colon",
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['../foo'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:8:9 Cross-package dependency must use syntax "<relative-path>:<script-name>", but there's no ":" character in "../foo".
            "../foo"
            ~~~~~~~~
`
    );
  })
);

test(
  "cross-package dependency doesn't have a script name",
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['../foo:'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:8:9 Cross-package dependency must use syntax "<relative-path>:<script-name>", but there's no script name in "../foo:".
            "../foo:"
            ~~~~~~~~~
`
    );
  })
);

test(
  'cross-package dependency resolves to the same package (".")',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['.:b'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:8:9 Cross-package dependency ".:b" resolved to the same package.
            ".:b"
            ~~~~~
`
    );
  })
);

test(
  'cross-package dependency resolves to the same package (up and back)',
  timeout(async ({rig}) => {
    await rig.write({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['../foo:b'],
          },
        },
      },
    });
    const result = rig.exec('npm run a', {cwd: 'foo'});
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:8:9 Cross-package dependency "../foo:b" resolved to the same package.
            "../foo:b"
            ~~~~~~~~~~
`
    );
  })
);

test(
  'cross-package dependency leads to directory without package.json',
  timeout(async ({rig}) => {
    await rig.write({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['../bar:b'],
          },
        },
      },
    });
    const result = rig.exec('npm run a', {cwd: 'foo'});
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:8:10 package.json file missing: "${rig.resolve(
        'bar/package.json'
      )}"
            "../bar:b"
             ~~~~~~`
    );
  })
);

test(
  'cross-package dependency leads to package.json with invalid JSON',
  timeout(async ({rig}) => {
    await rig.write({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['../bar:b'],
          },
        },
      },
      'bar/package.json': '{"scripts": {},}',
    });
    const result = rig.exec('npm run a', {cwd: 'foo'});
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ ..${pathlib.sep}bar${pathlib.sep}package.json:1:16 JSON syntax error
    {"scripts": {},}
                   ~
❌ ..${pathlib.sep}bar${pathlib.sep}package.json:1:16 JSON syntax error
    {"scripts": {},}
                   ~
`
    );
  })
);

test(
  'cycle of length 1',
  timeout(async ({rig}) => {
    //  a
    //  ^ \
    //  |  |
    //  +--+
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['a'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:6:5 Cycle detected in dependencies of "a".
        "a": {
        ~~~

    package.json:8:9 "a" points back to "a"
                "a"
                ~~~
`
    );
  })
);

test(
  'cycle of length 2',
  timeout(async ({rig}) => {
    //  a --> b
    //  ^     |
    //  |     |
    //  +-----+
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['b'],
          },
          b: {
            dependencies: ['a'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const {code, stderr} = await result.exit;
    assert.equal(code, 1);
    assertScriptOutputEquals(
      stderr,
      `
❌ package.json:7:5 Cycle detected in dependencies of "a".
        "a": {
        ~~~

    package.json:9:9 "a" points to "b"
                "b"
                ~~~

    package.json:14:9 "b" points back to "a"
                "a"
                ~~~
`
    );
  })
);

test(
  'cycle of length 3',
  timeout(async ({rig}) => {
    //  a --> b --> c
    //  ^           |
    //  |           |
    //  +-----------+
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
          c: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['b'],
          },
          b: {
            dependencies: ['c'],
          },
          c: {
            dependencies: ['a'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const {code, stderr} = await result.exit;
    assert.equal(code, 1);
    assertScriptOutputEquals(
      stderr,
      `
❌ package.json:8:5 Cycle detected in dependencies of "a".
        "a": {
        ~~~

    package.json:10:9 "a" points to "b"
                "b"
                ~~~

    package.json:15:9 "b" points to "c"
                "c"
                ~~~

    package.json:20:9 "c" points back to "a"
                "a"
                ~~~
`
    );
  })
);

test(
  '2 cycles of length 1',
  timeout(async ({rig}) => {
    //  a -----> b
    //  ^ \     ^ \
    //  | |     | |
    //  +-+     +-+
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['a', 'b'],
          },
          b: {
            dependencies: ['b'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const {code, stderr} = await result.exit;
    assert.equal(code, 1);
    assertScriptOutputEquals(
      stderr,
      `
❌ package.json:7:5 Cycle detected in dependencies of "a".
        "a": {
        ~~~

    package.json:9:9 "a" points back to "a"
                "a",
                ~~~
    `
    );
  })
);

test(
  'cycle with lead up and lead out',
  timeout(async ({rig}) => {
    //  a --> b --> c --> d --> e
    //        ^           |
    //        |           |
    //        +-----------+
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
          c: 'wireit',
          d: 'wireit',
          e: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['b'],
          },
          b: {
            dependencies: ['c'],
          },
          c: {
            dependencies: ['d'],
          },
          d: {
            dependencies: ['e', 'b'],
          },
          e: {
            command: 'true',
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const {code, stderr} = await result.exit;
    assert.equal(code, 1);
    assertScriptOutputEquals(
      stderr,
      `
❌ package.json:15:5 Cycle detected in dependencies of "b".
        "b": {
        ~~~

    package.json:17:9 "b" points to "c"
                "c"
                ~~~

    package.json:22:9 "c" points to "d"
                "d"
                ~~~

    package.json:28:9 "d" points back to "b"
                "b"
                ~~~`
    );
  })
);

test(
  'cycle with multiple trails',
  timeout(async ({rig}) => {
    //    +------+
    //   /        \
    //  /          v
    // a --> b --> c --> d
    //       ^          /
    //        \        /
    //         +------+
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
          c: 'wireit',
          d: 'wireit',
          e: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['b', 'c'],
          },
          b: {
            dependencies: ['c'],
          },
          c: {
            dependencies: ['d'],
          },
          d: {
            dependencies: ['b'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:16:5 Cycle detected in dependencies of "b".
        "b": {
        ~~~

    package.json:18:9 "b" points to "c"
                "c"
                ~~~

    package.json:23:9 "c" points to "d"
                "d"
                ~~~

    package.json:28:9 "d" points back to "b"
                "b"
                ~~~
      `
    );
  })
);

test(
  'cycle with multiple trails (with different dependency order)',
  timeout(async ({rig}) => {
    //    +------+
    //   /        \
    //  /          v
    // a --> b --> c --> d
    //       ^          /
    //        \        /
    //         +------+
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
          c: 'wireit',
          d: 'wireit',
          e: 'wireit',
        },
        wireit: {
          a: {
            // The order declared shouldn't affect the path we take to detect
            // the cycle.
            dependencies: ['c', 'b'],
          },
          b: {
            dependencies: ['c'],
          },
          c: {
            dependencies: ['d'],
          },
          d: {
            dependencies: ['b'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
  ❌ package.json:16:5 Cycle detected in dependencies of "b".
        "b": {
        ~~~

    package.json:18:9 "b" points to "c"
                "c"
                ~~~

    package.json:23:9 "c" points to "d"
                "d"
                ~~~

    package.json:28:9 "d" points back to "b"
                "b"
                ~~~
      `
    );
  })
);

test(
  'cycle across packages',
  timeout(async ({rig}) => {
    //  foo:a --> bar:b
    //    ^         |
    //    |         |
    //    +---------+
    await rig.write({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['../bar:b'],
          },
        },
      },
      'bar/package.json': {
        scripts: {
          b: 'wireit',
        },
        wireit: {
          b: {
            dependencies: ['../foo:a'],
          },
        },
      },
    });
    const result = rig.exec('npm run a', {cwd: 'foo'});
    const {code, stderr} = await result.exit;
    assert.equal(code, 1);
    assertScriptOutputEquals(
      stderr,
      `
❌ package.json:6:5 Cycle detected in dependencies of "a".
        "a": {
        ~~~

    package.json:8:9 "a" points to "../bar:b"
                "../bar:b"
                ~~~~~~~~~~

    ..${pathlib.sep}bar${pathlib.sep}package.json:8:9 "b" points back to "../foo:a"
                "../foo:a"
                ~~~~~~~~~~
`
    );
  })
);

test(
  'multiple errors',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
          c: 'wireit',
        },
        wireit: {
          a: {
            command: 'foo',
            dependencies: ['b', 'c'],
          },
          b: {},
          c: {},
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:15:5 A wireit config must set at least one of "command" or "dependencies", otherwise there is nothing for wireit to do.
        "b": {},
        ~~~
❌ package.json:16:5 A wireit config must set at least one of "command" or "dependencies", otherwise there is nothing for wireit to do.
        "c": {}
        ~~~`
    );
  })
);

test(`we don't produce a duplicate analysis error for the same dependency`, async ({
  rig,
}) => {
  await rig.write({
    'package.json': {
      scripts: {
        a: 'wireit',
        b: 'wireit',
        c: 'wireit',
        errors: 'wireit',
      },
      wireit: {
        a: {
          dependencies: ['b', 'c'],
        },
        b: {
          dependencies: ['errors'],
        },
        c: {
          dependencies: ['errors'],
        },
        errors: {
          command: {},
        },
      },
    },
  });
  const result = rig.exec('npm run a');
  const done = await result.exit;
  assert.equal(done.code, 1);
  assertScriptOutputEquals(
    done.stderr,
    `
❌ package.json:26:18 Expected a string, but was object.
          "command": {}
                     ~~`
  );
});

test(`we don't produce a duplicate not found error when there's multiple deps into the same file`, async ({
  rig,
}) => {
  await rig.write({
    'package.json': {
      scripts: {
        a: 'wireit',
      },
      wireit: {
        a: {
          dependencies: ['./child:error1', './child:error2'],
        },
      },
    },
  });
  const result = rig.exec('npm run a');
  const done = await result.exit;
  assert.equal(done.code, 1);
  assertScriptOutputEquals(
    done.stderr,
    `
❌ package.json:8:10 package.json file missing: "${rig.resolve(
      'child/package.json'
    )}"
            "./child:error1",
             ~~~~~~~
❌ package.json:9:10 package.json file missing: "${rig.resolve(
      'child/package.json'
    )}"
            "./child:error2"
             ~~~~~~~`
  );
});

test(`we don't produce a duplicate error when there's multiple deps into the same invalid file`, async ({
  rig,
}) => {
  await rig.write({
    'package.json': {
      scripts: {
        a: 'wireit',
      },
      wireit: {
        a: {
          dependencies: ['./child:error1', './child:error2'],
        },
      },
    },
    'child/package.json': {
      scripts: 'bad',
    },
  });
  const result = rig.exec('npm run a');
  const done = await result.exit;
  assert.equal(done.code, 1);
  assertScriptOutputEquals(
    done.stderr,
    `
❌ child${pathlib.sep}package.json:2:14 Expected an object, but was string.
      "scripts": "bad"
                 ~~~~~
❌ package.json:8:18 Cannot find script named "error1" in package "${rig.resolve(
      'child'
    )}"
            "./child:error1",
                     ~~~~~~
❌ package.json:9:18 Cannot find script named "error2" in package "${rig.resolve(
      'child'
    )}"
            "./child:error2"
                     ~~~~~~`
  );
});

test(`we don't produce a duplicate error when there's multiple deps on a script that fails`, async ({
  rig,
}) => {
  const willFail = await rig.newCommand();
  await rig.write({
    'package.json': {
      scripts: {
        a: 'wireit',
        b: 'wireit',
        c: 'wireit',
        errors: 'wireit',
      },
      wireit: {
        a: {
          dependencies: ['b', 'c'],
        },
        b: {
          dependencies: ['errors'],
        },
        c: {
          dependencies: ['errors'],
        },
        errors: {
          command: willFail.command,
        },
      },
    },
  });
  const result = rig.exec('npm run a');
  const invok = await willFail.nextInvocation();
  invok.exit(1);
  await invok.closed;
  const done = await result.exit;
  assert.equal(done.code, 1);
  assertScriptOutputEquals(
    done.stderr,
    `
❌ [errors] Failed with exit status 1`
  );
});

test(`repro an issue with looking for a colon in missing dependency`, async ({
  rig,
}) => {
  await rig.write('package.json', {
    scripts: {
      a: 'wireit',
      b: 'wireit',
    },
    wireit: {
      a: {
        // There's no colon in this dependency name, but there are more colons
        // later on in the file. Ensure that we still draw the squiggles
        // correctly.
        dependencies: ['c'],
      },
      b: {
        command: 'foo:bar important mainly that this includes a colon',
      },
    },
  });
  const execResult = rig.exec(`npm run a`);
  const done = await execResult.exit;
  assert.equal(done.code, 1);
  assertScriptOutputEquals(
    done.stderr,
    `
❌ package.json:9:9 Cannot find script named "c" in package "${rig.temp}"
            "c"
            ~~~`
  );
});

test.run();
