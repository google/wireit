/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import * as assert from 'uvu/assert';
import {suite} from 'uvu';
import {glob} from '../util/glob.js';
import {FilesystemTestRig} from './util/filesystem-test-rig.js';
import {makeWatcher} from '../watcher.js';
import {IS_WINDOWS} from '../util/windows.js';

interface Symlink {
  /** Where the symlink file points to. */
  target: string;
  /** The symlink file. */
  path: string;
  /** The type of symlink on Windows. */
  windowsType: 'file' | 'dir' | 'junction';
}

interface TestCase {
  mode: 'once' | 'watch';
  files: Array<string | Symlink>;
  patterns: string[];
  expected: string[] | 'ERROR';
  cwd?: string;
  followSymlinks?: boolean;
  includeDirectories?: boolean;
  expandDirectories?: boolean;
  throwIfOutsideCwd?: boolean;
  stats?: boolean;
}

const test = suite<{
  rig: FilesystemTestRig;
  check: (data: TestCase) => Promise<void>;
}>();

test.before.each(async (ctx) => {
  try {
    const rig = (ctx.rig = new FilesystemTestRig());
    await rig.setup();

    ctx.check = async ({
      mode,
      files,
      patterns,
      expected,
      cwd = '.',
      followSymlinks = true,
      includeDirectories = false,
      expandDirectories = false,
      throwIfOutsideCwd = false,
    }: TestCase): Promise<void> => {
      for (const file of files) {
        if (typeof file === 'string') {
          if (file.endsWith('/')) {
            // directory
            await rig.mkdir(file);
          } else {
            // file
            await rig.touch(file);
          }
        } else {
          // syk
          await rig.symlink(file.target, file.path, file.windowsType);
        }
      }

      if (expected !== 'ERROR') {
        // It's more convenient to write relative paths in expectations, but we
        // always get back absolute paths.
        expected = expected.map((path) => rig.resolve(path));
        if (pathlib.sep === '\\') {
          // On Windows we expect to get results back with "\" as the separator.
          expected = expected.map((path) => path.replace(/\//g, '\\'));
        }
      }

      if (mode === 'once') {
        let actual, error;
        try {
          actual = await glob(patterns, {
            cwd: rig.resolve(cwd),
            followSymlinks,
            includeDirectories,
            expandDirectories,
            throwIfOutsideCwd,
          });
        } catch (e) {
          error = e;
        }
        if (expected === 'ERROR') {
          if (error === undefined) {
            assert.unreachable('Expected an error');
          }
        } else if (error !== undefined) {
          throw error;
        } else if (actual === undefined) {
          throw new Error('Actual was undefined');
        } else {
          const actualPaths = actual.map((file) => file.path);
          assert.equal(actualPaths.sort(), expected.sort());
        }
      } else if (mode === 'watch') {
        const actual: string[] = [];
        if (patterns.length > 0) {
          await using fsWatcher = makeWatcher(
            patterns,
            rig.resolve(cwd),
            () => undefined,
            // We need ignoreInitial=false because we need the initial "add"
            // events to find out what chokidar has found (we usually only care
            // about changes, not initial files).
            false,
          );
          const watcher = fsWatcher.watcher;
          watcher.on('add', (path) => {
            actual.push(rig.resolve(path));
          });
          await new Promise<void>((resolve) =>
            watcher.on('ready', () => {
              resolve();
            }),
          );
        }
        if (expected === 'ERROR') {
          throw new Error('Not sure how to check chokidar errors yet');
        }
        assert.equal(actual.sort(), expected.sort());
      } else {
        throw new Error('Unknown mode', mode);
      }
    };
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

for (const mode of ['once', 'watch'] as const) {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const skipIfWatch = mode === 'watch' ? test.skip : test;
  const skipIfWatchOnWindows =
    // eslint-disable-next-line @typescript-eslint/unbound-method
    mode === 'watch' && IS_WINDOWS ? test.skip : test;

  test(`[${mode}] empty patterns`, ({check}) =>
    check({
      mode,
      files: ['foo'],
      patterns: [],
      expected: [],
    }));

  skipIfWatch(`[${mode}] normalizes trailing / in pattern`, ({check}) =>
    check({
      mode,
      files: ['foo'],
      patterns: ['foo/'],
      expected: ['foo'],
    }),
  );

  test(`[${mode}] normalizes ../ in pattern`, ({check}) =>
    check({
      mode,
      files: ['foo'],
      patterns: ['bar/../foo'],
      expected: ['foo'],
    }));

  test(`[${mode}] explicit file that does not exist`, ({check}) =>
    check({
      mode,
      files: [],
      patterns: ['foo'],
      expected: [],
    }));

  test(`[${mode}] * star`, ({check}) =>
    check({
      mode,
      files: ['foo', 'bar'],
      patterns: ['*'],
      expected: ['foo', 'bar'],
    }));

  test(`[${mode}] * star with ! negation`, ({check}) =>
    check({
      mode,
      files: ['foo', 'bar', 'baz'],
      patterns: ['*', '!bar'],
      expected: ['foo', 'baz'],
    }));

  test(`[${mode}] inclusion of directory with trailing slash`, ({check}) =>
    check({
      mode,
      files: ['foo/good/1', 'foo/good/2'],
      patterns: ['foo/'],
      expected: ['foo/good/1', 'foo/good/2'],
      expandDirectories: true,
    }));

  test(`[${mode}] inclusion of directory without trailing slash`, ({check}) =>
    check({
      mode,
      files: ['foo/good/1', 'foo/good/2'],
      patterns: ['foo'],
      expected: ['foo/good/1', 'foo/good/2'],
      expandDirectories: true,
    }));

  test(`[${mode}] !exclusion of directory with trailing slash`, ({check}) =>
    check({
      mode,
      files: ['foo/good/1', 'foo/bad/1'],
      patterns: ['foo', '!foo/bad/'],
      expected: ['foo/good/1'],
      expandDirectories: true,
    }));

  test(`[${mode}] !exclusion of directory without trailing slash`, ({check}) =>
    check({
      mode,
      files: ['foo/good/1', 'foo/bad/1'],
      patterns: ['foo', '!foo/bad'],
      expected: ['foo/good/1'],
      expandDirectories: true,
    }));

  test(`[${mode}] explicit .dotfile`, ({check}) =>
    check({
      mode,
      files: ['.foo'],
      patterns: ['.foo'],
      expected: ['.foo'],
    }));

  test(`[${mode}] * star matches .dotfiles`, ({check}) =>
    check({
      mode,
      files: ['.foo'],
      patterns: ['*'],
      expected: ['.foo'],
    }));

  test(`[${mode}] {} groups`, ({check}) =>
    check({
      mode,
      files: ['foo', 'bar', 'baz'],
      patterns: ['{foo,baz}'],
      expected: ['foo', 'baz'],
    }));

  test(`[${mode}] matches explicit symlink`, ({check}) =>
    check({
      mode,
      files: [
        'target',
        {target: 'target', path: 'symlink', windowsType: 'file'},
      ],
      patterns: ['symlink'],
      expected: ['symlink'],
    }));

  test(`[${mode}] explicit directory excluded when includeDirectories=false`, ({
    check,
  }) =>
    check({
      mode,
      files: ['foo/'],
      patterns: ['foo'],
      expected: [],
    }));

  test(`[${mode}] explicit directory included when includeDirectories=true`, ({
    check,
  }) =>
    check({
      mode,
      files: ['foo/'],
      patterns: ['foo'],
      expected: [],
    }));

  skipIfWatch(
    `[${mode}] explicit directory included when includeDirectories=true`,
    ({check}) =>
      check({
        mode,
        files: ['foo/'],
        patterns: ['foo'],
        expected: ['foo'],
        includeDirectories: true,
      }),
  );

  test(`[${mode}] * star excludes directory when includeDirectories=false`, ({
    check,
  }) =>
    check({
      mode,
      files: ['foo/'],
      patterns: ['*'],
      expected: [],
    }));

  skipIfWatch(
    `[${mode}] * star includes directory when includeDirectories=true`,
    ({check}) =>
      check({
        mode,
        files: ['foo/'],
        patterns: ['*'],
        expected: ['foo'],
        includeDirectories: true,
      }),
  );

  skipIfWatch(
    `[${mode}] includeDirectories=false + expandDirectories=false`,
    ({check}) =>
      check({
        mode,
        files: [
          '1',
          '2',
          'foo/1',
          'foo/2',
          'foo/bar/1',
          'foo/bar/2',
          'foo/baz/',
        ],
        patterns: ['foo'],
        expected: [],
        includeDirectories: false,
        expandDirectories: false,
      }),
  );

  skipIfWatch(
    `[${mode}] includeDirectories=true + expandDirectories=false`,
    ({check}) =>
      check({
        mode,
        files: [
          '1',
          '2',
          'foo/1',
          'foo/2',
          'foo/bar/1',
          'foo/bar/2',
          'foo/baz/',
        ],
        patterns: ['foo'],
        expected: ['foo'],
        includeDirectories: true,
        expandDirectories: false,
      }),
  );

  test(`[${mode}] includeDirectories=false + expandDirectories=true`, ({
    check,
  }) =>
    check({
      mode,
      files: ['1', '2', 'foo/1', 'foo/2', 'foo/bar/1', 'foo/bar/2', 'foo/baz/'],
      patterns: ['foo'],
      expected: ['foo/1', 'foo/2', 'foo/bar/1', 'foo/bar/2'],
      includeDirectories: false,
      expandDirectories: true,
    }));

  skipIfWatch(
    `[${mode}] includeDirectories=true + expandDirectories=true`,
    ({check}) =>
      check({
        mode,
        files: [
          '1',
          '2',
          'foo/1',
          'foo/2',
          'foo/bar/1',
          'foo/bar/2',
          'foo/baz/',
        ],
        patterns: ['foo'],
        expected: [
          'foo',
          'foo/1',
          'foo/2',
          'foo/bar',
          'foo/bar/1',
          'foo/bar/2',
          'foo/baz',
        ],
        includeDirectories: true,
        expandDirectories: true,
      }),
  );

  skipIfWatch(
    `[${mode}] includeDirectories=true + expandDirectories=true + recursive !exclusion`,
    ({check}) =>
      check({
        mode,
        files: [
          '1',
          '2',
          'foo/1',
          'foo/2',
          'foo/bar/1',
          'foo/bar/2',
          'foo/baz/',
        ],
        patterns: [
          'foo',
          // This exclusion pattern needs to match recursively too. We don't just
          // exclude the "foo/bar" directory, we also exclude its recursive
          // children.
          '!foo/bar',
        ],
        expected: ['foo', 'foo/1', 'foo/2', 'foo/baz'],
        includeDirectories: true,
        expandDirectories: true,
      }),
  );

  skipIfWatch(
    `[${mode}] . matches current directory with includeDirectories=true`,
    ({check}) =>
      check({
        mode,
        files: [
          '1',
          '2',
          'foo/1',
          'foo/2',
          'foo/bar/1',
          'foo/bar/2',
          'foo/baz/',
        ],
        patterns: ['.'],
        expected: ['.'],
        includeDirectories: true,
      }),
  );

  test(`[${mode}] . matches current directory with expandDirectories=true`, ({
    check,
  }) =>
    check({
      mode,
      files: ['1', '2', 'foo/1', 'foo/2', 'foo/bar/1', 'foo/bar/2', 'foo/baz/'],
      patterns: ['.'],
      expected: ['1', '2', 'foo/1', 'foo/2', 'foo/bar/1', 'foo/bar/2'],
      expandDirectories: true,
    }));

  skipIfWatch(`[${mode}] {} groups with expand directories`, ({check}) =>
    check({
      mode,
      files: ['1', '2', 'foo/1', 'foo/2', 'foo/bar/1', 'foo/bar/2', 'foo/baz/'],
      patterns: ['{foo,baz}'],
      expected: ['foo/1', 'foo/2', 'foo/bar/1', 'foo/bar/2'],
      expandDirectories: true,
    }),
  );

  skipIfWatch(`[${mode}] empty pattern throws`, ({check}) =>
    check({
      mode,
      files: ['foo', 'bar'],
      patterns: [''],
      expected: 'ERROR',
    }),
  );

  skipIfWatch(
    `[${mode}] empty pattern throws with expandDirectories=true`,
    ({check}) =>
      check({
        mode,
        files: ['foo', 'bar'],
        patterns: [''],
        expected: 'ERROR',
        expandDirectories: true,
      }),
  );

  skipIfWatch(`[${mode}] whitespace pattern throws`, ({check}) =>
    check({
      mode,
      files: ['foo', 'bar'],
      patterns: [' '],
      expected: 'ERROR',
    }),
  );

  skipIfWatch(
    `[${mode}] whitespace pattern throws with expandDirectories=true`,
    ({check}) =>
      check({
        mode,
        files: ['foo', 'bar'],
        patterns: [' '],
        expected: 'ERROR',
        expandDirectories: true,
      }),
  );

  skipIfWatchOnWindows(`[${mode}] re-inclusion of file`, ({check}) =>
    check({
      mode,
      files: ['foo'],
      patterns: ['!foo', 'foo'],
      expected: ['foo'],
    }),
  );

  skipIfWatch(`[${mode}] re-inclusion of directory`, ({check}) =>
    check({
      mode,
      files: ['foo/'],
      patterns: ['!foo', 'foo'],
      expected: ['foo'],
      includeDirectories: true,
    }),
  );

  skipIfWatch(`[${mode}] re-inclusion of file into directory`, ({check}) =>
    check({
      mode,
      files: ['foo/1', 'foo/bar/1', 'foo/bar/baz', 'foo/qux'],
      patterns: ['foo/**', '!foo/bar/**', 'foo/bar/baz', '!foo/qux'],
      expected: ['foo/1', 'foo/bar/baz'],
    }),
  );

  test(`[${mode}] re-inclusion of file into directory with expandDirectories=true`, ({
    check,
  }) =>
    check({
      mode,
      files: ['foo/1', 'foo/bar/1', 'foo/bar/baz', 'foo/qux'],
      patterns: ['foo', '!foo/bar', 'foo/bar/baz', '!foo/qux'],
      expected: ['foo/1', 'foo/bar/baz'],
      expandDirectories: true,
    }));

  test(`[${mode}] re-inclusion of directory into directory with expandDirectories=true`, ({
    check,
  }) =>
    check({
      mode,
      files: ['foo/1', 'foo/bar/1', 'foo/bar/baz/1'],
      patterns: ['foo', '!foo/bar', 'foo/bar/baz'],
      expected: ['foo/1', 'foo/bar/baz/1'],
      expandDirectories: true,
    }));

  skipIfWatch(
    `[${mode}] walks through symlinked directories when followSymlinks=true`,
    ({check}) =>
      check({
        mode,
        files: [
          'target/foo',
          {target: 'target', path: 'symlink', windowsType: 'dir'},
        ],
        patterns: ['**'],
        expected: ['target', 'target/foo', 'symlink', 'symlink/foo'],
        includeDirectories: true,
        followSymlinks: true,
      }),
  );

  skipIfWatch(
    `[${mode}] does not walk through symlinked directories when followSymlinks=false`,
    ({check}) =>
      check({
        mode,
        files: [
          'target/foo',
          {target: 'target', path: 'symlink', windowsType: 'dir'},
        ],
        patterns: ['**'],
        expected: ['target', 'target/foo', 'symlink'],
        includeDirectories: true,
        followSymlinks: false,
      }),
  );

  skipIfWatch(
    `[${mode}] does not expand directly specified symlinked directories when followSymlinks=false`,
    ({check}) =>
      check({
        mode,
        files: [
          'target/foo',
          {target: 'target', path: 'symlink', windowsType: 'dir'},
        ],
        patterns: ['symlink'],
        expected: ['symlink'],
        followSymlinks: false,
        includeDirectories: true,
        expandDirectories: true,
      }),
  );

  test(`[${mode}] dirent tags files`, async ({rig}) => {
    await rig.touch('foo');
    const actual = await glob(['foo'], {
      cwd: rig.temp,
      followSymlinks: true,
      includeDirectories: true,
      expandDirectories: false,
      throwIfOutsideCwd: false,
    });
    assert.equal(actual.length, 1);
    assert.equal(actual[0]!.path, rig.resolve('foo'));
    assert.ok(actual[0]!.dirent.isFile());
    assert.not(actual[0]!.dirent.isDirectory());
    assert.not(actual[0]!.dirent.isSymbolicLink());
  });

  test(`[${mode}] dirent tags directories`, async ({rig}) => {
    await rig.mkdir('foo');
    const actual = await glob(['foo'], {
      cwd: rig.temp,
      followSymlinks: true,
      includeDirectories: true,
      expandDirectories: false,
      throwIfOutsideCwd: false,
    });
    assert.equal(actual.length, 1);
    assert.equal(actual[0]!.path, rig.resolve('foo'));
    assert.not(actual[0]!.dirent.isFile());
    assert.ok(actual[0]!.dirent.isDirectory());
    assert.not(actual[0]!.dirent.isSymbolicLink());
  });

  test(`[${mode}] dirent tags symlinks when followSymlinks=false`, async ({
    rig,
  }) => {
    await rig.symlink('target', 'foo', 'file');
    const actual = await glob(['foo'], {
      cwd: rig.temp,
      followSymlinks: false,
      includeDirectories: true,
      expandDirectories: false,
      throwIfOutsideCwd: false,
    });
    assert.equal(actual.length, 1);
    assert.equal(actual[0]!.path, rig.resolve('foo'));
    assert.not(actual[0]!.dirent.isFile());
    assert.not(actual[0]!.dirent.isDirectory());
    assert.ok(actual[0]!.dirent.isSymbolicLink());
  });

  test(`[${mode}] dirent tags symlinks to files as files when followSymlinks=true`, async ({
    rig,
  }) => {
    await rig.symlink('target', 'foo', 'file');
    await rig.touch('target');
    const actual = await glob(['foo'], {
      cwd: rig.temp,
      followSymlinks: true,
      includeDirectories: true,
      expandDirectories: false,
      throwIfOutsideCwd: false,
    });
    assert.equal(actual.length, 1);
    assert.equal(actual[0]!.path, rig.resolve('foo'));
    assert.ok(actual[0]!.dirent.isFile());
    assert.not(actual[0]!.dirent.isDirectory());
    assert.not(actual[0]!.dirent.isSymbolicLink());
  });

  test(`[${mode}] dirent tags symlinks to directories as directories when followSymlinks=true`, async ({
    rig,
  }) => {
    await rig.symlink('target', 'foo', 'dir');
    await rig.mkdir('target');
    const actual = await glob(['foo'], {
      cwd: rig.temp,
      followSymlinks: true,
      includeDirectories: true,
      expandDirectories: false,
      throwIfOutsideCwd: false,
    });
    assert.equal(actual.length, 1);
    assert.equal(actual[0]!.path, rig.resolve('foo'));
    assert.not(actual[0]!.dirent.isFile());
    assert.ok(actual[0]!.dirent.isDirectory());
    assert.not(actual[0]!.dirent.isSymbolicLink());
  });

  test(`[${mode}] re-roots to cwd`, ({check}) =>
    check({
      mode,
      files: ['foo'],
      patterns: ['/foo'],
      expected: ['foo'],
    }));

  test(`[${mode}] re-roots to cwd with exclusion`, ({check}) =>
    check({
      mode,
      files: ['foo', 'bar', 'baz'],
      patterns: ['/*', '!/bar'],
      expected: ['foo', 'baz'],
    }));

  if (mode !== 'watch') {
    test(`[${mode}] re-rooting allows ../`, ({check}) =>
      check({
        mode,
        cwd: 'subdir',
        files: ['foo', 'subdir/'],
        patterns: ['../foo'],
        expected: ['foo'],
      }));
  }

  test(`[${mode}] re-rooting handles /./foo`, ({check}) =>
    check({
      mode,
      files: ['foo'],
      patterns: ['/./foo'],
      expected: ['foo'],
    }));

  if (mode !== 'watch') {
    test(`[${mode}] re-rooting handles /../foo`, ({check}) =>
      check({
        mode,
        cwd: 'subdir',
        files: ['foo', 'subdir/'],
        patterns: ['/../foo'],
        expected: ['foo'],
      }));

    test(`[${mode}] re-rooting handles /bar/../foo/`, ({check}) =>
      check({
        mode,
        files: ['foo'],
        patterns: ['/bar/../foo/'],
        expected: ['foo'],
      }));

    test(`[${mode}] re-roots to cwd with braces`, ({check}) =>
      check({
        mode,
        files: ['foo', 'bar'],
        patterns: ['{/foo,/bar}'],
        expected: ['foo', 'bar'],
      }));

    test(`[${mode}] braces can be escaped`, ({check}) =>
      check({
        mode,
        files: ['{foo,bar}'],
        patterns: ['\\{foo,bar\\}'],
        expected: ['{foo,bar}'],
      }));
  }

  skipIfWatch(
    `[${mode}] disallows path outside cwd when throwIfOutsideCwd=true`,
    ({check}) =>
      check({
        mode,
        cwd: 'subdir',
        files: ['foo', 'subdir/'],
        patterns: ['../foo'],
        expected: 'ERROR',
        throwIfOutsideCwd: true,
      }),
  );

  skipIfWatch(
    `[${mode}] allows path outside cwd when throwIfOutsideCwd=false`,
    ({check}) =>
      check({
        mode,
        cwd: 'subdir',
        files: ['foo', 'subdir/'],
        patterns: ['../foo'],
        expected: ['foo'],
        throwIfOutsideCwd: false,
      }),
  );

  test(`[${mode}] allows path inside cwd when throwIfOutsideCwd=true`, ({
    check,
  }) =>
    check({
      mode,
      files: ['foo'],
      patterns: ['foo'],
      expected: ['foo'],
      throwIfOutsideCwd: true,
    }));
}

test.run();
