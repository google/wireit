/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {IS_WINDOWS} from '../util/windows.js';
import {checkScriptOutput} from './util/check-script-output.js';
import {rigTest} from './util/rig-test.js';

const test = suite<object>();

test(
  'wireit section is not an object',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:5:13 Expected an object, but was array.
      "wireit": []
                ~~
❌ package.json:3:10 This script is configured to run wireit but it has no config in the wireit section of this package.json file
        "a": "wireit"
             ~~~~~~~~`,
    );
  }),
);

test(
  'wireit config is not an object',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:6:10 Expected an object, but was array.
        "a": []
             ~~
❌ package.json:3:10 This script is configured to run wireit but it has no config in the wireit section of this package.json file
        "a": "wireit"
             ~~~~~~~~`,
    );
  }),
);

test(
  'dependencies is not an array',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:7:23 Expected an array, but was object.
          "dependencies": {}
                          ~~`,
    );
  }),
);

test(
  'dependency is not a string',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:8:9 Expected a string or object, but was array.
            []
            ~~`,
    );
  }),
);

test(
  `dependencies.script is not a string (object form)`,
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:9:21 Expected a string, but was array.
              "script": []
                        ~~`,
    );
  }),
);

test(
  'dependency is empty or blank',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:8:9 Expected this field to be nonempty
            " "
            ~~~`,
    );
  }),
);

test(
  `dependencies.script is empty or blank (object form)`,
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:14:21 Expected this field to be nonempty
              "script": ""
                        ~~`,
    );
  }),
);

test(
  `dependencies.script is missing (object form)`,
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:13:9 Dependency object must set a "script" property.
            {}
            ~~`,
    );
  }),
);

test(
  'command is not a string',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:7:18 Expected a string, but was array.
          "command": []
                     ~~`,
    );
  }),
);

test(
  'command is empty or blank',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:7:18 Expected this field to be nonempty
          "command": ""
                     ~~`,
    );
  }),
);

test(
  'files is not an array',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:8:16 Expected an array, but was object.
          "files": {}
                   ~~`,
    );
  }),
);

test(
  'file item is not a string',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:9:9 Expected a string, but was number.
            0
            ~`,
    );
  }),
);

test(
  'file item is empty or blank',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:9:9 Expected this field to be nonempty
            ""
            ~~`,
    );
  }),
);

test(
  'output is not an array',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:8:17 Expected an array, but was object.
          "output": {}
                    ~~`,
    );
  }),
);

test(
  'output item is not a string',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:9:9 Expected a string, but was number.
            0
            ~`,
    );
  }),
);

test(
  'output item is empty or blank',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:9:9 Expected this field to be nonempty
            " \\t\\n "
            ~~~~~~~~`,
    );
  }),
);

test(
  'clean is not a boolean or "if-file-deleted"',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:8:16 The "clean" property must be either true, false, or "if-file-deleted".
          "clean": 0
                   ~`,
    );
  }),
);

test(
  'allowUsuallyExcludedPaths is not a boolean',
  rigTest(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            allowUsuallyExcludedPaths: 1,
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:8:36 Must be true or false
          "allowUsuallyExcludedPaths": 1
                                       ~`,
    );
  }),
);

test(
  'packageLocks is not an array',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:8:23 Expected an array, but was number.
          "packageLocks": 0
                          ~`,
    );
  }),
);

test(
  'packageLocks item is not a string',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:9:9 Expected a string, but was number.
            0
            ~`,
    );
  }),
);

test(
  'packageLocks item is empty or blank',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:9:9 Expected this field to be nonempty
            " "
            ~~~`,
    );
  }),
);

test(
  'packageLocks item is not a filename',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:9:9 A package lock must be a filename, not a path
            "../package-lock.json"
            ~~~~~~~~~~~~~~~~~~~~~~`,
    );
  }),
);

test(
  'missing dependency',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:8:9 Cannot find script named "missing" in package "${rig.temp}"
            "missing"
            ~~~~~~~~~`,
    );
  }),
);

test(
  'missing cross package dependency',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:8:18 Cannot find script named "missing" in package "${rig.resolve(
        'child',
      )}"
            "./child:missing"
                     ~~~~~~~`,
    );
  }),
);

test(
  'missing cross package dependency (object form)',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:9:30 Cannot find script named "missing" in package "${rig.resolve(
        'child',
      )}"
              "script": "./child:missing"
                                 ~~~~~~~`,
    );
  }),
);

test(
  'missing same-package dependency with colon in name',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:8:9 Cannot find script named "test:missing" in package "${rig.temp}"
            "test:missing"
            ~~~~~~~~~~~~~~`,
    );
  }),
);

test(
  'missing cross package dependency with complicated escaped names',
  rigTest(async ({rig}) => {
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
            dependencies: ['./ch\t\\\\ ild:mis\t\\\\ sing'],
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
    checkScriptOutput(
      done.stderr,
      String.raw`
❌ package.json:8:25 Cannot find script named "mis\t\\ sing" in package "${rig.resolve(
        'ch\t\\ ild',
      )}"
            "./ch\t\\\\ ild:mis\t\\\\ sing"
                            ~~~~~~~~~~~~~~`,
    );
  }),
);

test(
  'cross-package dependency with complicated escaped name leads to directory without package.json',
  rigTest(async ({rig}) => {
    await rig.write({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['../b\t\\\\ ar:b'],
          },
        },
      },
    });
    const result = rig.exec('npm run a', {cwd: 'foo'});
    const done = await result.exit;
    assert.equal(done.code, 1);
    checkScriptOutput(
      done.stderr,
      String.raw`
❌ package.json:8:10 package.json file missing: "${rig.resolve(
        'b\t\\ ar/package.json',
      )}"
            "../b\t\\\\ ar:b"
             ~~~~~~~~~~~~~`,
    );
  }),
);

test(
  'duplicate dependency',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:10:9 This dependency is listed multiple times
            "b"
            ~~~

    package.json:9:9 The dependency was first listed here.
                "b",
                ~~~`,
    );
  }),
);

test(
  'script command is not wireit',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:4:10 This command should just be "wireit", as this script is configured in the wireit section.
        "b": "not-wireit"
             ~~~~~~~~~~~~

    package.json:12:5 The wireit config is here.
            "b": {
            ~~~
`.trimStart(),
    );
  }),
);

test(
  'script is wireit but has no wireit config',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:3:10 This script is configured to run wireit but it has no config in the wireit section of this package.json file
        "a": "wireit"
             ~~~~~~~~
`,
    );
  }),
);

test(
  'script has no command, dependencies, or files',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:6:5 A wireit config must set at least one of "command", "dependencies", or "files". Otherwise there is nothing for wireit to do.
        "a": {}
        ~~~`,
    );
  }),
);

test(
  'script has no command and empty dependencies and files',
  rigTest(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            files: [],
            dependencies: [],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:6:5 A wireit config must set at least one of "command", "dependencies", or "files". Otherwise there is nothing for wireit to do.
        "a": {
        ~~~`,
    );
  }),
);

test(
  "cross-package dependency doesn't have a colon",
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:8:10 Cross-package dependency must use syntax "<relative-path>#<script-name>", but there's no "#" character in "../foo".
            "../foo"
             ~~~~~~
`,
    );
  }),
);

test(
  "cross-package dependency doesn't have a script name",
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:8:10 Cross-package dependency must use syntax "<relative-path>#<script-name>", but there's no script name in "../foo:".
            "../foo:"
             ~~~~~~~
`,
    );
  }),
);

test(
  'cross-package dependency resolves to the same package (".")',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:8:10 Cross-package dependency ".:b" resolved to the same package.
            ".:b"
             ~
`,
    );
  }),
);

test(
  'cross-package dependency resolves to the same package (up and back)',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:8:10 Cross-package dependency "../foo:b" resolved to the same package.
            "../foo:b"
             ~~~~~~
`,
    );
  }),
);

test(
  'cross-package dependency leads to directory without package.json',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:8:10 package.json file missing: "${rig.resolve(
        'bar/package.json',
      )}"
            "../bar:b"
             ~~~~~~`,
    );
  }),
);

test(
  'cross-package dependency leads to package.json with invalid JSON',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ ..${pathlib.sep}bar${pathlib.sep}package.json:1:16 JSON syntax error
    {"scripts": {},}
                   ~
❌ ..${pathlib.sep}bar${pathlib.sep}package.json:1:16 JSON syntax error
    {"scripts": {},}
                   ~
`,
    );
  }),
);

test(
  'cycle of length 1',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:6:5 Cycle detected in dependencies of "a".
        "a": {
        ~~~

    package.json:8:9 "a" points back to "a"
                "a"
                ~~~
`,
    );
  }),
);

test(
  'cycle of length 2',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
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
`,
    );
  }),
);

test(
  'cycle of length 3',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
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
`,
    );
  }),
);

test(
  '2 cycles of length 1',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      stderr,
      `
❌ package.json:7:5 Cycle detected in dependencies of "a".
        "a": {
        ~~~

    package.json:9:9 "a" points back to "a"
                "a",
                ~~~
    `,
    );
  }),
);

test(
  'cycle with lead up and lead out',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
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
                ~~~`,
    );
  }),
);

test(
  'cycle with multiple trails',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
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
      `,
    );
  }),
);

test(
  'cycle with multiple trails (with different dependency order)',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
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
      `,
    );
  }),
);

test(
  'cycle across packages',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
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
`,
    );
  }),
);

test(
  'multiple errors',
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:15:5 A wireit config must set at least one of "command", "dependencies", or "files". Otherwise there is nothing for wireit to do.
        "b": {},
        ~~~
❌ package.json:16:5 A wireit config must set at least one of "command", "dependencies", or "files". Otherwise there is nothing for wireit to do.
        "c": {}
        ~~~`,
    );
  }),
);

test(
  `we don't produce a duplicate analysis error for the same dependency`,
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:26:18 Expected a string, but was object.
          "command": {}
                     ~~`,
    );
  }),
);

test(
  `we don't produce a duplicate not found error when there's multiple deps into the same file`,
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:8:10 package.json file missing: "${rig.resolve(
        'child/package.json',
      )}"
            "./child:error1",
             ~~~~~~~`,
    );
  }),
);

test(
  `we don't produce a duplicate error when there's multiple deps into the same invalid file`,
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ child${pathlib.sep}package.json:2:14 Expected an object, but was string.
      "scripts": "bad"
                 ~~~~~
❌ package.json:8:18 Cannot find script named "error1" in package "${rig.resolve(
        'child',
      )}"
            "./child:error1",
                     ~~~~~~`,
    );
  }),
);

test(
  `we don't produce a duplicate error when there's multiple deps on a script that fails`,
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ [errors] exited with exit code 1.
❌ 1 script failed.`,
    );
  }),
);

test(
  `repro an issue with looking for a colon in missing dependency`,
  rigTest(async ({rig}) => {
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:9:9 Cannot find script named "c" in package "${rig.temp}"
            "c"
            ~~~`,
    );
  }),
);

test(
  'script without command cannot have output',
  rigTest(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['b'],
            output: ['foo'],
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:11:7 "output" can only be set if "command" is also set.
          "output": [
          ~~~~~~~~~~~
            "foo"
    ~~~~~~~~~~~~~
          ]
    ~~~~~~~`,
    );
  }),
);

test(
  'service is not a boolean or object',
  rigTest(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            service: 1,
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:8:18 The "service" property must be either true, false, or an object.
          "service": 1
                     ~`,
    );
  }),
);

test(
  'service does not have command',
  rigTest(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
        },
        wireit: {
          a: {
            service: true,
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:8:18 A "service" script must have a "command".
          "service": true,
                     ~~~~`,
    );
  }),
);

test(
  'service cannot have output',
  rigTest(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            service: true,
            output: ['foo'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:9:17 A "service" script cannot have an "output".
          "output": [
                    ~
            "foo"
    ~~~~~~~~~~~~~
          ]
    ~~~~~~~`,
    );
  }),
);

test(
  'dependencies.cascade is not a boolean',
  rigTest(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
        },
        wireit: {
          a: {
            dependencies: [
              {
                script: 'b',
                cascade: 1,
              },
            ],
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
    checkScriptOutput(
      done.stderr,
      `
❌ package.json:11:22 The "cascade" property must be either true or false.
              "cascade": 1
                         ~`,
    );
  }),
);

test(
  'service.readyWhen must be an object',
  rigTest(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            service: {
              readyWhen: 1,
            },
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    checkScriptOutput(
      done.stderr,
      `
    ❌ package.json:8:18 Expected an object.
          "service": {
                     ~
            "readyWhen": 1
    ~~~~~~~~~~~~~~~~~~~~~~
          }
    ~~~~~~~`,
    );
  }),
);

test(
  'service.readyWhen.lineMatches must be a string',
  rigTest(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            service: {
              readyWhen: {
                lineMatches: 1,
              },
            },
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    checkScriptOutput(
      done.stderr,
      `
      ❌ package.json:10:26 Expected a string.
              "lineMatches": 1
                             ~`,
    );
  }),
);

test(
  'service.readyWhen.lineMatches must be a valid regular expression',
  rigTest(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            service: {
              readyWhen: {
                lineMatches: 'invalid[',
              },
            },
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    checkScriptOutput(
      done.stderr,
      `
        ❌ package.json:10:26 SyntaxError: Invalid regular expression: /invalid[/: Unterminated character class
              "lineMatches": "invalid["
                             ~~~~~~~~~~`,
    );
  }),
);

test(
  'env must be an object',
  rigTest(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            env: [],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    checkScriptOutput(
      done.stderr,
      `
        ❌ package.json:8:14 Expected an object
          "env": []
                 ~~`,
    );
  }),
);

test(
  'env entry value must be a string or object',
  rigTest(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            env: {
              FOO: 1,
            },
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    checkScriptOutput(
      done.stderr,
      `
        ❌ package.json:9:16 Expected a string or object
            "FOO": 1
                   ~`,
    );
  }),
);

test(
  'env entry value that is object must have an "external" property',
  rigTest(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            env: {
              FOO: {
                EXTERNAL: true,
              },
            },
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    checkScriptOutput(
      done.stderr,
      `
      ❌ package.json:9:16 Expected "external" to be true
            "FOO": {
                   ~
              "EXTERNAL": true
    ~~~~~~~~~~~~~~~~~~~~~~~~~~
            }
    ~~~~~~~~~`,
    );
  }),
);

test(
  'env entry value that is object must have "external" set to true',
  rigTest(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            env: {
              FOO: {
                external: false,
              },
            },
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    checkScriptOutput(
      done.stderr,
      `
      ❌ package.json:10:23 Expected "external" to be true
              "external": false
                          ~~~~~`,
    );
  }),
);

test(
  'env entry value that is object with "default" property must be a string',
  rigTest(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            env: {
              FOO: {
                external: true,
                default: {},
              },
            },
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    checkScriptOutput(
      done.stderr,
      `
      ❌ package.json:11:22 Expected "default" to be a string
              "default": {}
                         ~~`,
    );
  }),
);

test(
  "script with no command can't have env",
  rigTest(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            files: ['foo'],
            env: {
              FOO: 'foo',
            },
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    checkScriptOutput(
      done.stderr,
      `
      ❌ package.json:10:14 Can't set "env" unless "command" is set
          "env": {
                 ~
            "FOO": "foo"
    ~~~~~~~~~~~~~~~~~~~~
          }
    ~~~~~~~`,
    );
  }),
);

test.run();
