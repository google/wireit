import {readConfig} from '../shared/read-config.js';
import {exec as execCallback} from 'child_process';
import {promisify} from 'util';
import {readState, writeState} from '../shared/read-write-state.js';
import {dirname} from 'path';

import type {Config} from '../types/config.js';
import type {State} from '../types/state.js';

const exec = promisify(execCallback);

export default async (args: string[]) => {
  if (args.length !== 1 && process.env.npm_lifecycle_event === undefined) {
    throw new Error(`run: Expected 1 argument, but got ${args.length}`);
  }
  const taskName = args[0] ?? process.env.npm_lifecycle_event;

  const watch = true;
  do {
    const {config, packageJsonPath} = await readConfig();
    console.log('=====================================');
    let state;
    try {
      state = await readState(dirname(packageJsonPath));
    } catch (e) {
      state = {tasks: {}};
    }
    const watchGlobs: string[] = [packageJsonPath];
    await run(
      config,
      packageJsonPath,
      taskName,
      state,
      watch,
      watchGlobs,
      new Map()
    );
    await writeState(dirname(packageJsonPath), state);
    console.log('=====================================');
    if (watch) {
      await new Promise<void>(async (resolve) => {
        const chokidar = await import('chokidar');
        const watcher = chokidar.watch(watchGlobs).on('change', async () => {
          await watcher.close();
          resolve();
        });
      });
    }
  } while (watch);
};

const run = async (
  config: Config,
  packageJsonPath: string,
  taskName: string,
  state: State,
  watch: boolean,
  watchGlobs: Array<string>,
  doneTaskIds: Map<string, Promise<boolean>>
): Promise<boolean> => {
  const taskId = JSON.stringify({packageJsonPath, taskName});
  let taskRanPromise = doneTaskIds.get(taskId);
  if (taskRanPromise !== undefined) {
    return taskRanPromise;
  }

  let resolveTaskRan: (value: boolean) => void;
  taskRanPromise = new Promise<boolean>((resolve) => {
    resolveTaskRan = resolve;
  });
  doneTaskIds.set(taskId, taskRanPromise);

  const task = config.tasks?.[taskName];
  if (task === undefined) {
    throw new Error(
      `run: Could not find task ${taskName} in wireit.tasks` +
        ` from ${packageJsonPath}`
    );
  }

  const taskDeps: Array<Promise<boolean>> = [];
  const nonTaskDeps: Array<{ruleName: string; ruleArgs: string}> = [];
  for (const dep of task.dependencies ?? []) {
    const match = dep.match(/^([^:]+)(?::(.*))?$/);
    if (match === null) {
      throw new Error(
        `Invalid dependency syntax ${dep}` +
          ', must match syntax "rulename[:ruleargs]"'
      );
    }
    const [, ruleName, ruleArgs] = match;
    if (ruleName === 'task') {
      taskDeps.push(
        run(
          config,
          packageJsonPath,
          ruleArgs,
          state,
          watch,
          watchGlobs,
          doneTaskIds
        )
      );
    } else {
      nonTaskDeps.push({ruleName, ruleArgs});
    }
  }
  const anyDependencyTasksRan = (await Promise.all(taskDeps)).some(
    (result) => result
  );

  const cacheKeyPromises: Array<Promise<string | boolean | null>> = [];
  for (const {ruleName, ruleArgs} of nonTaskDeps) {
    cacheKeyPromises.push(
      (async () => {
        const ruleModule = await import(`../rules/${ruleName}.js`);
        const ruleClass = ruleModule.default;
        const rule = new ruleClass();
        if (watch) {
          watchGlobs.push(...rule.watchPaths(ruleArgs));
        }
        return rule.cacheKey(ruleArgs);
      })()
    );
  }

  const cacheData = {
    command: task.command,
    dependencies: (await Promise.all(cacheKeyPromises))
      .map((cacheKey, idx) => {
        const {ruleName, ruleArgs} = nonTaskDeps[idx];
        return `${ruleName}:${ruleArgs}:${cacheKey}`;
      })
      .sort(),
  };

  const cacheKey = JSON.stringify(cacheData);

  let taskState = state.tasks[taskName];
  if (taskState === undefined) {
    taskState = {};
    state.tasks[taskName] = taskState;
  } else if (!anyDependencyTasksRan && cacheKey === taskState.cacheKey) {
    console.log(`[${taskName}] Cached`);
    resolveTaskRan!(false);
    return taskRanPromise;
  }

  console.log(`[${taskName}] Running`);
  console.log('    ', {
    oldKey: taskState.cacheKey,
    newKey: cacheKey,
    anyDependencyTasksRan,
  });
  if (task.command !== undefined) {
    const {stdout, stderr} = await exec(task.command);
    console.log(stdout);
    console.log(stderr);
  }

  taskState.cacheKey = cacheKey;
  resolveTaskRan!(true);
  return taskRanPromise;
};
