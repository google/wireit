/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {rigTest} from './util/rig-test.js';
import {
  Executor,
  registerExecutorConstructorHook,
  ServiceMap,
} from '../executor.js';
import {Analyzer} from '../analyzer.js';
import {DefaultLogger} from '../logging/default-logger.js';
import {WorkerPool} from '../util/worker-pool.js';
import {registerExecutionConstructorHook} from '../execution/base.js';
import {Console} from '../logging/logger.js';

const test = suite<object>();

let numLiveExecutors = 0;
let numLiveExecutions = 0;

const collectGarbage = (() => {
  if (global.gc == null) {
    throw new Error('gc.test must be invoked with --expose-gc');
  }
  return global.gc;
})();

test.before.each(() => {
  try {
    const executorFinalizationRegistry = new FinalizationRegistry(() => {
      numLiveExecutors--;
    });
    registerExecutorConstructorHook((executor) => {
      numLiveExecutors++;
      executorFinalizationRegistry.register(executor, null);
    });

    const executionFinalizationRegistry = new FinalizationRegistry(() => {
      numLiveExecutions--;
    });
    registerExecutionConstructorHook((execution) => {
      numLiveExecutions++;
      executionFinalizationRegistry.register(execution, null);
    });
  } catch (error) {
    // Uvu has a bug where it silently ignores failures in before and after,
    // see https://github.com/lukeed/uvu/issues/191.
    console.error('uvu before error', error);
    process.exit(1);
  }
});

test.after.each(() => {
  try {
    numLiveExecutors = 0;
    numLiveExecutions = 0;
  } catch (error) {
    // Uvu has a bug where it silently ignores failures in before and after,
    // see https://github.com/lukeed/uvu/issues/191.
    console.error('uvu after error', error);
    process.exit(1);
  }
});

async function retryWithGcUntilCallbackDoesNotThrow(
  cb: () => void,
): Promise<void> {
  for (const wait of [0, 10, 100, 500, 1000]) {
    collectGarbage();
    try {
      cb();
      return;
    } catch {
      // Ignore
    }
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  // Final attempt without a try, to let the exception bubble up.
  cb();
}

test(
  'standard garbage collection',
  rigTest(async ({rig}) => {
    const standard = await rig.newCommand();
    await rig.writeAtomic({
      'package.json': {
        scripts: {
          standard: 'wireit',
        },
        wireit: {
          standard: {
            command: standard.command,
          },
        },
      },
    });

    const console = new Console(process.stderr, process.stderr);
    const logger = new DefaultLogger(rig.temp, console);
    const script = await new Analyzer('npm').analyze(
      {packageDir: rig.temp, name: 'standard'},
      [],
    );
    if (!script.config.ok) {
      for (const error of script.config.error) {
        logger.log(error);
      }
      throw new Error(`Analysis error`);
    }

    const workerPool = new WorkerPool(Infinity);

    const numIterations = 10;
    for (let i = 0; i < numIterations; i++) {
      const executor = new Executor(
        script.config.value,
        logger,
        workerPool,
        undefined,
        'no-new',
        undefined,
        true,
      );
      const resultPromise = executor.execute();
      assert.ok(numLiveExecutors >= 1);
      assert.ok(numLiveExecutions >= 1);
      (await standard.nextInvocation()).exit(0);
      const result = await resultPromise;
      if (result.errors.length > 0) {
        for (const error of result.errors) {
          logger.log(error);
        }
        throw new Error(`Execution error`);
      }
    }

    await retryWithGcUntilCallbackDoesNotThrow(() => {
      // TODO(aomarks) Not sure why it's 1 instead of 0, but as long as it's not
      // numIterations we're OK.
      assert.equal(numLiveExecutors, 1);
      assert.equal(numLiveExecutions, 1);
    });
    assert.equal(standard.numInvocations, numIterations);
  }),
);

test(
  'persistent service garbage collection',
  rigTest(async ({rig}) => {
    const service = await rig.newCommand();
    await rig.writeAtomic({
      'package.json': {
        scripts: {
          service: 'wireit',
        },
        wireit: {
          service: {
            command: service.command,
            service: true,
          },
        },
      },
    });

    const console = new Console(process.stderr, process.stderr);
    const logger = new DefaultLogger(rig.temp, console);
    const script = await new Analyzer('npm').analyze(
      {packageDir: rig.temp, name: 'service'},
      [],
    );
    if (!script.config.ok) {
      for (const error of script.config.error) {
        logger.log(error);
      }
      throw new Error(`Analysis error`);
    }

    const workerPool = new WorkerPool(Infinity);

    const numIterations = 10;
    let previousServices: ServiceMap | undefined;
    for (let i = 0; i < numIterations; i++) {
      const executor = new Executor(
        script.config.value,
        logger,
        workerPool,
        undefined,
        'no-new',
        previousServices,
        true,
      );
      const resultPromise = executor.execute();
      assert.ok(numLiveExecutors >= 1);
      assert.ok(numLiveExecutions >= 1);
      const result = await resultPromise;
      if (result.errors.length > 0) {
        for (const error of result.errors) {
          logger.log(error);
        }
        throw new Error(`Execution error`);
      }
      previousServices = result.persistentServices;
      if (i === 0) {
        await service.nextInvocation();
      }
    }

    for (const service of previousServices!.values()) {
      await service.abort();
    }

    await retryWithGcUntilCallbackDoesNotThrow(() => {
      // TODO(aomarks) Not sure why it's 1 instead of 0, but as long as it's not
      // numIterations we're OK.
      assert.equal(numLiveExecutors, 1);
      assert.equal(numLiveExecutions, 1);
    });
    assert.equal(service.numInvocations, 1);
  }),
);

test(
  'no-command, standard, persistent service, and ephemeral service garbage collection',
  rigTest(async ({rig}) => {
    const standard = await rig.newCommand();
    const servicePersistent = await rig.newCommand();
    const serviceEphemeral = await rig.newCommand();
    await rig.writeAtomic({
      'package.json': {
        scripts: {
          entrypoint: 'wireit',
          standard: 'wireit',
          servicePersistent: 'wireit',
          serviceEphemeral: 'wireit',
        },
        wireit: {
          entrypoint: {
            dependencies: ['standard', 'servicePersistent'],
          },
          standard: {
            command: standard.command,
            dependencies: ['serviceEphemeral'],
          },
          servicePersistent: {
            command: servicePersistent.command,
            service: true,
          },
          serviceEphemeral: {
            command: serviceEphemeral.command,
            service: true,
          },
        },
      },
    });

    const console = new Console(process.stderr, process.stderr);
    const logger = new DefaultLogger(rig.temp, console);
    const script = await new Analyzer('npm').analyze(
      {packageDir: rig.temp, name: 'entrypoint'},
      [],
    );
    if (!script.config.ok) {
      for (const error of script.config.error) {
        logger.log(error);
      }
      throw new Error(`Analysis error`);
    }

    const workerPool = new WorkerPool(Infinity);

    const numIterations = 10;
    let previousServices: ServiceMap | undefined;
    for (let i = 0; i < numIterations; i++) {
      const executor = new Executor(
        script.config.value,
        logger,
        workerPool,
        undefined,
        'no-new',
        previousServices,
        true,
      );
      const resultPromise = executor.execute();
      assert.ok(numLiveExecutors >= 1);
      assert.ok(numLiveExecutions >= 1);
      if (i === 0) {
        await servicePersistent.nextInvocation();
      }
      await serviceEphemeral.nextInvocation();
      (await standard.nextInvocation()).exit(0);
      const result = await resultPromise;
      if (result.errors.length > 0) {
        for (const error of result.errors) {
          logger.log(error);
        }
        throw new Error(`Execution error`);
      }
      previousServices = result.persistentServices;
    }

    for (const service of previousServices!.values()) {
      await service.abort();
    }

    await retryWithGcUntilCallbackDoesNotThrow(() => {
      // TODO(aomarks) Not sure why it's 1 and 4 instead of 0, but as long as
      // it's not a factor of numIterations we're OK.
      assert.equal(numLiveExecutors, 1);
      assert.equal(numLiveExecutions, 4);
    });
    assert.equal(standard.numInvocations, numIterations);
    assert.equal(servicePersistent.numInvocations, 1);
    assert.equal(serviceEphemeral.numInvocations, numIterations);
  }),
);

test.run();
