/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import {test} from 'node:test';
import * as assert from 'node:assert';
import {glob} from '../util/glob.js';
import {IS_WINDOWS} from '../util/windows.js';
import {makeWatcher} from '../watcher.js';
import {FilesystemTestRig} from './util/filesystem-test-rig.js';

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

async function setup(): Promise<
  {
    rig: FilesystemTestRig;
    check: (data: TestCase) => Promise<void>;
  } & AsyncDisposable
> {
  const rig = new FilesystemTestRig();
  await rig.setup();

  const check = async ({
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
          assert.fail('Expected an error');
        }
      } else if (error !== undefined) {
        throw error;
      } else if (actual === undefined) {
        throw new Error('Actual was undefined');
      } else {
        const actualPaths = actual.map((file) => file.path);
        assert.deepStrictEqual(actualPaths.sort(), expected.sort());
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
          {strategy: 'event'},
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
      assert.deepStrictEqual(actual.sort(), expected.sort());
    } else {
      throw new Error('Unknown mode', mode);
    }
  };

  return {
    rig,
    check,
    async [Symbol.asyncDispose]() {
      await rig.cleanup();
    },
  };
}

for (const mode of ['once', 'watch'] as const) {
  const skipIfWatch = mode === 'watch';
  const skipIfWatchOnWindows = mode === 'watch' && IS_WINDOWS;

  void test(`[${mode}] empty patterns`, async () => {
    await using ctx = await setup();
    await ctx.check({
      mode,
      files: ['foo'],
      patterns: [],
      expected: [],
    });
  });

  void test(
    `[${mode}] normalizes trailing / in pattern`,
    {skip: skipIfWatch},
    async () => {
      await using ctx = await setup();
      await ctx.check({
        mode,
        files: ['foo'],
        patterns: ['foo/'],
        expected: ['foo'],
      });
    },
  );

  void test(`[${mode}] normalizes ../ in pattern`, async () => {
    await using ctx = await setup();
    await ctx.check({
      mode,
      files: ['foo'],
      patterns: ['bar/../foo'],
      expected: ['foo'],
    });
  });

  void test(`[${mode}] explicit file that does not exist`, async () => {
    await using ctx = await setup();
    await ctx.check({
      mode,
      files: [],
      patterns: ['foo'],
      expected: [],
    });
  });

  void test(`[${mode}] * star`, async () => {
    await using ctx = await setup();
    await ctx.check({
      mode,
      files: ['foo', 'bar'],
      patterns: ['*'],
      expected: ['foo', 'bar'],
    });
  });

  void test(`[${mode}] * star with ! negation`, async () => {
    await using ctx = await setup();
    await ctx.check({
      mode,
      files: ['foo', 'bar', 'baz'],
      patterns: ['*', '!bar'],
      expected: ['foo', 'baz'],
    });
  });

  void test(`[${mode}] inclusion of directory with trailing slash`, async () => {
    await using ctx = await setup();
    await ctx.check({
      mode,
      files: ['foo/good/1', 'foo/good/2'],
      patterns: ['foo/'],
      expected: ['foo/good/1', 'foo/good/2'],
      expandDirectories: true,
    });
  });

  void test(`[${mode}] inclusion of directory without trailing slash`, async () => {
    await using ctx = await setup();
    await ctx.check({
      mode,
      files: ['foo/good/1', 'foo/good/2'],
      patterns: ['foo'],
      expected: ['foo/good/1', 'foo/good/2'],
      expandDirectories: true,
    });
  });

  void test(`[${mode}] !exclusion of directory with trailing slash`, async () => {
    await using ctx = await setup();
    await ctx.check({
      mode,
      files: ['foo/good/1', 'foo/bad/1'],
      patterns: ['foo', '!foo/bad/'],
      expected: ['foo/good/1'],
      expandDirectories: true,
    });
  });

  void test(`[${mode}] !exclusion of directory without trailing slash`, async () => {
    await using ctx = await setup();
    await ctx.check({
      mode,
      files: ['foo/good/1', 'foo/bad/1'],
      patterns: ['foo', '!foo/bad'],
      expected: ['foo/good/1'],
      expandDirectories: true,
    });
  });

  void test(`[${mode}] explicit .dotfile`, async () => {
    await using ctx = await setup();
    await ctx.check({
      mode,
      files: ['.foo'],
      patterns: ['.foo'],
      expected: ['.foo'],
    });
  });

  void test(`[${mode}] * star matches .dotfiles`, async () => {
    await using ctx = await setup();
    await ctx.check({
      mode,
      files: ['.foo'],
      patterns: ['*'],
      expected: ['.foo'],
    });
  });

  void test(`[${mode}] {} groups`, async () => {
    await using ctx = await setup();
    await ctx.check({
      mode,
      files: ['foo', 'bar', 'baz'],
      patterns: ['{foo,baz}'],
      expected: ['foo', 'baz'],
    });
  });

  void test(`[${mode}] matches explicit symlink`, async () => {
    await using ctx = await setup();
    await ctx.check({
      mode,
      files: [
        'target',
        {target: 'target', path: 'symlink', windowsType: 'file'},
      ],
      patterns: ['symlink'],
      expected: ['symlink'],
    });
  });

  void test(`[${mode}] explicit directory excluded when includeDirectories=false`, async () => {
    await using ctx = await setup();
    await ctx.check({
      mode,
      files: ['foo/'],
      patterns: ['foo'],
      expected: [],
    });
  });

  void test(`[${mode}] explicit directory included when includeDirectories=true`, async () => {
    await using ctx = await setup();
    await ctx.check({
      mode,
      files: ['foo/'],
      patterns: ['foo'],
      expected: [],
    });
  });

  void test(
    `[${mode}] explicit directory included when includeDirectories=true`,
    {skip: skipIfWatch},
    async () => {
      await using ctx = await setup();
      await ctx.check({
        mode,
        files: ['foo/'],
        patterns: ['foo'],
        expected: ['foo'],
        includeDirectories: true,
      });
    },
  );

  void test(`[${mode}] * star excludes directory when includeDirectories=false`, async () => {
    await using ctx = await setup();
    await ctx.check({
      mode,
      files: ['foo/'],
      patterns: ['*'],
      expected: [],
    });
  });

  void test(
    `[${mode}] * star includes directory when includeDirectories=true`,
    {skip: skipIfWatch},
    async () => {
      await using ctx = await setup();
      await ctx.check({
        mode,
        files: ['foo/'],
        patterns: ['*'],
        expected: ['foo'],
        includeDirectories: true,
      });
    },
  );

  void test(
    `[${mode}] includeDirectories=false + expandDirectories=false`,
    {skip: skipIfWatch},
    async () => {
      await using ctx = await setup();
      await ctx.check({
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
      });
    },
  );

  void test(
    `[${mode}] includeDirectories=true + expandDirectories=false`,
    {skip: skipIfWatch},
    async () => {
      await using ctx = await setup();
      await ctx.check({
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
      });
    },
  );

  void test(`[${mode}] includeDirectories=false + expandDirectories=true`, async () => {
    await using ctx = await setup();
    await ctx.check({
      mode,
      files: ['1', '2', 'foo/1', 'foo/2', 'foo/bar/1', 'foo/bar/2', 'foo/baz/'],
      patterns: ['foo'],
      expected: ['foo/1', 'foo/2', 'foo/bar/1', 'foo/bar/2'],
      includeDirectories: false,
      expandDirectories: true,
    });
  });

  void test(
    `[${mode}] includeDirectories=true + expandDirectories=true`,
    {skip: skipIfWatch},
    async () => {
      await using ctx = await setup();
      await ctx.check({
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
      });
    },
  );

  void test(
    `[${mode}] includeDirectories=true + expandDirectories=true + recursive !exclusion`,
    {skip: skipIfWatch},
    async () => {
      await using ctx = await setup();
      await ctx.check({
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
      });
    },
  );

  void test(
    `[${mode}] . matches current directory with includeDirectories=true`,
    {skip: skipIfWatch},
    async () => {
      await using ctx = await setup();
      await ctx.check({
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
      });
    },
  );

  void test(`[${mode}] . matches current directory with expandDirectories=true`, async () => {
    await using ctx = await setup();
    await ctx.check({
      mode,
      files: ['1', '2', 'foo/1', 'foo/2', 'foo/bar/1', 'foo/bar/2', 'foo/baz/'],
      patterns: ['.'],
      expected: ['1', '2', 'foo/1', 'foo/2', 'foo/bar/1', 'foo/bar/2'],
      expandDirectories: true,
    });
  });

  void test(
    `[${mode}] {} groups with expand directories`,
    {skip: skipIfWatch},
    async () => {
      await using ctx = await setup();
      await ctx.check({
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
        patterns: ['{foo,baz}'],
        expected: ['foo/1', 'foo/2', 'foo/bar/1', 'foo/bar/2'],
        expandDirectories: true,
      });
    },
  );

  void test(`[${mode}] empty pattern throws`, {skip: skipIfWatch}, async () => {
    await using ctx = await setup();
    await ctx.check({
      mode,
      files: ['foo', 'bar'],
      patterns: [''],
      expected: 'ERROR',
    });
  });

  void test(
    `[${mode}] empty pattern throws with expandDirectories=true`,
    {skip: skipIfWatch},
    async () => {
      await using ctx = await setup();
      await ctx.check({
        mode,
        files: ['foo', 'bar'],
        patterns: [''],
        expected: 'ERROR',
        expandDirectories: true,
      });
    },
  );

  void test(
    `[${mode}] whitespace pattern throws`,
    {skip: skipIfWatch},
    async () => {
      await using ctx = await setup();
      await ctx.check({
        mode,
        files: ['foo', 'bar'],
        patterns: [' '],
        expected: 'ERROR',
      });
    },
  );

  void test(
    `[${mode}] whitespace pattern throws with expandDirectories=true`,
    {skip: skipIfWatch},
    async () => {
      await using ctx = await setup();
      await ctx.check({
        mode,
        files: ['foo', 'bar'],
        patterns: [' '],
        expected: 'ERROR',
        expandDirectories: true,
      });
    },
  );

  void test(
    `[${mode}] re-inclusion of file`,
    {skip: skipIfWatchOnWindows},
    async () => {
      await using ctx = await setup();
      await ctx.check({
        mode,
        files: ['foo'],
        patterns: ['!foo', 'foo'],
        expected: ['foo'],
      });
    },
  );

  void test(
    `[${mode}] re-inclusion of directory`,
    {skip: skipIfWatch},
    async () => {
      await using ctx = await setup();
      await ctx.check({
        mode,
        files: ['foo/'],
        patterns: ['!foo', 'foo'],
        expected: ['foo'],
        includeDirectories: true,
      });
    },
  );

  void test(
    `[${mode}] re-inclusion of file into directory`,
    {skip: skipIfWatch},
    async () => {
      await using ctx = await setup();
      await ctx.check({
        mode,
        files: ['foo/1', 'foo/bar/1', 'foo/bar/baz', 'foo/qux'],
        patterns: ['foo/**', '!foo/bar/**', 'foo/bar/baz', '!foo/qux'],
        expected: ['foo/1', 'foo/bar/baz'],
      });
    },
  );

  void test(`[${mode}] re-inclusion of file into directory with expandDirectories=true`, async () => {
    await using ctx = await setup();
    await ctx.check({
      mode,
      files: ['foo/1', 'foo/bar/1', 'foo/bar/baz', 'foo/qux'],
      patterns: ['foo', '!foo/bar', 'foo/bar/baz', '!foo/qux'],
      expected: ['foo/1', 'foo/bar/baz'],
      expandDirectories: true,
    });
  });

  void test(`[${mode}] re-inclusion of directory into directory with expandDirectories=true`, async () => {
    await using ctx = await setup();
    await ctx.check({
      mode,
      files: ['foo/1', 'foo/bar/1', 'foo/bar/baz/1'],
      patterns: ['foo', '!foo/bar', 'foo/bar/baz'],
      expected: ['foo/1', 'foo/bar/baz/1'],
      expandDirectories: true,
    });
  });

  void test(
    `[${mode}] walks through symlinked directories when followSymlinks=true`,
    {skip: skipIfWatch},
    async () => {
      await using ctx = await setup();
      await ctx.check({
        mode,
        files: [
          'target/foo',
          {target: 'target', path: 'symlink', windowsType: 'dir'},
        ],
        patterns: ['**'],
        expected: ['target', 'target/foo', 'symlink', 'symlink/foo'],
        includeDirectories: true,
        followSymlinks: true,
      });
    },
  );

  void test(
    `[${mode}] does not walk through symlinked directories when followSymlinks=false`,
    {skip: skipIfWatch},
    async () => {
      await using ctx = await setup();
      await ctx.check({
        mode,
        files: [
          'target/foo',
          {target: 'target', path: 'symlink', windowsType: 'dir'},
        ],
        patterns: ['**'],
        expected: ['target', 'target/foo', 'symlink'],
        includeDirectories: true,
        followSymlinks: false,
      });
    },
  );

  void test(
    `[${mode}] does not expand directly specified symlinked directories when followSymlinks=false`,
    {skip: skipIfWatch},
    async () => {
      await using ctx = await setup();
      await ctx.check({
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
      });
    },
  );

  void test(`[${mode}] dirent tags files`, async () => {
    await using ctx = await setup();
    const {rig} = ctx;
    await rig.touch('foo');
    const actual = await glob(['foo'], {
      cwd: rig.temp,
      followSymlinks: true,
      includeDirectories: true,
      expandDirectories: false,
      throwIfOutsideCwd: false,
    });
    assert.deepStrictEqual(actual.length, 1);
    assert.deepStrictEqual(actual[0]!.path, rig.resolve('foo'));
    assert.ok(actual[0]!.dirent.isFile());
    assert.ok(!actual[0]!.dirent.isDirectory());
    assert.ok(!actual[0]!.dirent.isSymbolicLink());
  });

  void test(`[${mode}] dirent tags directories`, async () => {
    await using ctx = await setup();
    const {rig} = ctx;
    await rig.mkdir('foo');
    const actual = await glob(['foo'], {
      cwd: rig.temp,
      followSymlinks: true,
      includeDirectories: true,
      expandDirectories: false,
      throwIfOutsideCwd: false,
    });
    assert.deepStrictEqual(actual.length, 1);
    assert.deepStrictEqual(actual[0]!.path, rig.resolve('foo'));
    assert.ok(!actual[0]!.dirent.isFile());
    assert.ok(actual[0]!.dirent.isDirectory());
    assert.ok(!actual[0]!.dirent.isSymbolicLink());
  });

  void test(`[${mode}] dirent tags symlinks when followSymlinks=false`, async () => {
    await using ctx = await setup();
    const {rig} = ctx;
    await rig.symlink('target', 'foo', 'file');
    const actual = await glob(['foo'], {
      cwd: rig.temp,
      followSymlinks: false,
      includeDirectories: true,
      expandDirectories: false,
      throwIfOutsideCwd: false,
    });
    assert.deepStrictEqual(actual.length, 1);
    assert.deepStrictEqual(actual[0]!.path, rig.resolve('foo'));
    assert.ok(!actual[0]!.dirent.isFile());
    assert.ok(!actual[0]!.dirent.isDirectory());
    assert.ok(actual[0]!.dirent.isSymbolicLink());
  });

  void test(`[${mode}] dirent tags symlinks to files as files when followSymlinks=true`, async () => {
    await using ctx = await setup();
    const {rig} = ctx;
    await rig.symlink('target', 'foo', 'file');
    await rig.touch('target');
    const actual = await glob(['foo'], {
      cwd: rig.temp,
      followSymlinks: true,
      includeDirectories: true,
      expandDirectories: false,
      throwIfOutsideCwd: false,
    });
    assert.deepStrictEqual(actual.length, 1);
    assert.deepStrictEqual(actual[0]!.path, rig.resolve('foo'));
    assert.ok(actual[0]!.dirent.isFile());
    assert.ok(!actual[0]!.dirent.isDirectory());
    assert.ok(!actual[0]!.dirent.isSymbolicLink());
  });

  void test(`[${mode}] dirent tags symlinks to directories as directories when followSymlinks=true`, async () => {
    await using ctx = await setup();
    const {rig} = ctx;
    await rig.symlink('target', 'foo', 'dir');
    await rig.mkdir('target');
    const actual = await glob(['foo'], {
      cwd: rig.temp,
      followSymlinks: true,
      includeDirectories: true,
      expandDirectories: false,
      throwIfOutsideCwd: false,
    });
    assert.deepStrictEqual(actual.length, 1);
    assert.deepStrictEqual(actual[0]!.path, rig.resolve('foo'));
    assert.ok(!actual[0]!.dirent.isFile());
    assert.ok(actual[0]!.dirent.isDirectory());
    assert.ok(!actual[0]!.dirent.isSymbolicLink());
  });

  void test(`[${mode}] re-roots to cwd`, async () => {
    await using ctx = await setup();
    await ctx.check({
      mode,
      files: ['foo'],
      patterns: ['/foo'],
      expected: ['foo'],
    });
  });

  void test(`[${mode}] re-roots to cwd with exclusion`, async () => {
    await using ctx = await setup();
    await ctx.check({
      mode,
      files: ['foo', 'bar', 'baz'],
      patterns: ['/*', '!/bar'],
      expected: ['foo', 'baz'],
    });
  });

  if (mode !== 'watch') {
    void test(`[${mode}] re-rooting allows ../`, async () => {
      await using ctx = await setup();
      await ctx.check({
        mode,
        cwd: 'subdir',
        files: ['foo', 'subdir/'],
        patterns: ['../foo'],
        expected: ['foo'],
      });
    });
  }

  void test(`[${mode}] re-rooting handles /./foo`, async () => {
    await using ctx = await setup();
    await ctx.check({
      mode,
      files: ['foo'],
      patterns: ['/./foo'],
      expected: ['foo'],
    });
  });

  if (mode !== 'watch') {
    void test(`[${mode}] re-rooting handles /../foo`, async () => {
      await using ctx = await setup();
      await ctx.check({
        mode,
        cwd: 'subdir',
        files: ['foo', 'subdir/'],
        patterns: ['/../foo'],
        expected: ['foo'],
      });
    });

    void test(`[${mode}] re-rooting handles /bar/../foo/`, async () => {
      await using ctx = await setup();
      await ctx.check({
        mode,
        files: ['foo'],
        patterns: ['/bar/../foo/'],
        expected: ['foo'],
      });
    });

    void test(`[${mode}] re-roots to cwd with braces`, async () => {
      await using ctx = await setup();
      await ctx.check({
        mode,
        files: ['foo', 'bar'],
        patterns: ['{/foo,/bar}'],
        expected: ['foo', 'bar'],
      });
    });

    void test(`[${mode}] braces can be escaped`, async () => {
      await using ctx = await setup();
      await ctx.check({
        mode,
        files: ['{foo,bar}'],
        patterns: ['\\{foo,bar\\}'],
        expected: ['{foo,bar}'],
      });
    });
  }

  void test(
    `[${mode}] disallows path outside cwd when throwIfOutsideCwd=true`,
    {skip: skipIfWatch},
    async () => {
      await using ctx = await setup();
      await ctx.check({
        mode,
        cwd: 'subdir',
        files: ['foo', 'subdir/'],
        patterns: ['../foo'],
        expected: 'ERROR',
        throwIfOutsideCwd: true,
      });
    },
  );

  void test(
    `[${mode}] allows path outside cwd when throwIfOutsideCwd=false`,
    {skip: skipIfWatch},
    async () => {
      await using ctx = await setup();
      await ctx.check({
        mode,
        cwd: 'subdir',
        files: ['foo', 'subdir/'],
        patterns: ['../foo'],
        expected: ['foo'],
        throwIfOutsideCwd: false,
      });
    },
  );

  void test(`[${mode}] allows path inside cwd when throwIfOutsideCwd=true`, async () => {
    await using ctx = await setup();
    await ctx.check({
      mode,
      files: ['foo'],
      patterns: ['foo'],
      expected: ['foo'],
      throwIfOutsideCwd: true,
    });
  });
}
