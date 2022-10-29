/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {timeout} from './util/uvu-timeout.js';
import {WireitTestRig} from './util/test-rig.js';
import {IS_WINDOWS} from '../util/windows.js';

const test = suite<{rig: WireitTestRig}>();

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
  'simple consumer and service with stdout',
  timeout(async ({rig}) => {
    // consumer
    //    |
    //    v
    // service

    const consumer = await rig.newCommand();
    const service = await rig.newCommand();
    await rig.writeAtomic({
      'package.json': {
        scripts: {
          consumer: 'wireit',
          service: 'wireit',
        },
        wireit: {
          consumer: {
            command: consumer.command,
            dependencies: ['service'],
          },
          service: {
            command: service.command,
            service: true,
          },
        },
      },
    });

    const wireit = rig.exec('npm run consumer');

    // The service starts because the consumer depends on it
    const serviceInv = await service.nextInvocation();
    await wireit.waitForLog(/Service started/);

    // Confirm we show stdout/stderr from services
    serviceInv.stdout('service stdout');
    await wireit.waitForLog(/service stdout/);
    serviceInv.stderr('service stderr');
    await wireit.waitForLog(/service stderr/);

    // The consumer starts and finishes
    const consumerInv = await consumer.nextInvocation();
    // Wait a moment to ensure the service stays running
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(serviceInv.isRunning);
    consumerInv.exit(0);

    // The service stops because the consumer is done
    await serviceInv.closed;
    await wireit.waitForLog(/Service stopped/);

    await wireit.exit;
    assert.equal(service.numInvocations, 1);
    assert.equal(consumer.numInvocations, 1);
  })
);

test(
  'service with standard and service deps',
  timeout(async ({rig}) => {
    //  consumer
    //     |
    //     v
    //  service ---> serviceDep
    //     |
    //     v
    // standardDep

    const consumer = await rig.newCommand();
    const service = await rig.newCommand();
    const standardDep = await rig.newCommand();
    const serviceDep = await rig.newCommand();
    await rig.writeAtomic({
      'package.json': {
        scripts: {
          consumer: 'wireit',
          service: 'wireit',
          standardDep: 'wireit',
          serviceDep: 'wireit',
        },
        wireit: {
          consumer: {
            command: consumer.command,
            dependencies: ['service'],
          },
          service: {
            command: service.command,
            service: true,
            dependencies: ['standardDep', 'serviceDep'],
          },
          standardDep: {
            command: standardDep.command,
          },
          serviceDep: {
            command: serviceDep.command,
            service: true,
          },
        },
      },
    });

    const wireit = rig.exec('npm run consumer');

    // The service's standard dep must finish before the service can start
    const standardDepInv = await standardDep.nextInvocation();
    // Wait a moment to ensure the service hasn't started yet
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(service.numInvocations, 0);
    assert.equal(serviceDep.numInvocations, 0);
    assert.equal(consumer.numInvocations, 0);
    standardDepInv.exit(0);

    // The service's own service dep must start first
    const serviceDepInv = await serviceDep.nextInvocation();
    await wireit.waitForLog(/\[serviceDep\] Service started/);

    // Now the main service can start
    const serviceInv = await service.nextInvocation();
    await wireit.waitForLog(/\[service\] Service started/);

    // The consumer starts and finishes
    const consumerInv = await consumer.nextInvocation();
    // Wait a moment to ensure the services stay running
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(serviceInv.isRunning);
    assert.ok(serviceDepInv.isRunning);
    consumerInv.exit(0);

    // Services shut down in reverse order
    await serviceInv.closed;
    await wireit.waitForLog(/\[service\] Service stopped/);
    await serviceDepInv.closed;
    await wireit.waitForLog(/\[serviceDep\] Service stopped/);

    await wireit.exit;
    assert.equal(standardDep.numInvocations, 1);
    assert.equal(serviceDep.numInvocations, 1);
    assert.equal(service.numInvocations, 1);
    assert.equal(consumer.numInvocations, 1);
  })
);

test(
  'standard scripts are killed when service exits unexpectedly',
  timeout(async ({rig}) => {
    // consumer
    //    |
    //    v
    // service

    const consumer = await rig.newCommand();
    const service = await rig.newCommand();
    await rig.writeAtomic({
      'package.json': {
        scripts: {
          consumer: 'wireit',
          service: 'wireit',
        },
        wireit: {
          consumer: {
            command: consumer.command,
            dependencies: ['service'],
          },
          service: {
            command: service.command,
            service: true,
          },
        },
      },
    });

    const wireit = rig.exec('npm run consumer');

    // Service starts
    const serviceInv = await service.nextInvocation();

    // Consumer starts
    const consumerInv = await consumer.nextInvocation();

    // Service exits unexpectedly
    serviceInv.exit(1);
    await wireit.waitForLog(/\[service\] Service exited unexpectedly/);

    // Consumer is killed
    await consumerInv.closed;
    await wireit.waitForLog(/\[consumer\] Killed/);

    // Wireit exits with an error code
    assert.equal((await wireit.exit).code, 1);
  })
);

test(
  'service remembers unexpected exit failure for next start call',
  timeout(async ({rig}) => {
    //     entrypoint
    //     /        \
    //    v          v
    // consumer1   consumer2
    //    \         /    \
    //     \       /      v
    //      v     v     blocker
    //      service

    const consumer1 = await rig.newCommand();
    const consumer2 = await rig.newCommand();
    const service = await rig.newCommand();
    const blocker = await rig.newCommand();

    await rig.writeAtomic({
      'package.json': {
        scripts: {
          entrypoint: 'wireit',
          consumer1: 'wireit',
          consumer2: 'wireit',
          service: 'wireit',
          blocker: 'wireit',
        },
        wireit: {
          entrypoint: {
            dependencies: ['consumer1', 'consumer2'],
          },
          consumer1: {
            command: consumer1.command,
            dependencies: ['service'],
          },
          consumer2: {
            command: consumer2.command,
            dependencies: ['service', 'blocker'],
          },
          service: {
            command: service.command,
            service: true,
          },
          blocker: {
            command: blocker.command,
          },
        },
      },
    });

    const wireit = rig.exec('npm run entrypoint', {
      env: {
        // Set "continue" failure mode so that consumer2 tries to start the
        // service even though consumer1 will have already failed.
        WIREIT_FAILURES: 'continue',
      },
    });

    // Service starts
    const serviceInv = await service.nextInvocation();

    // Blocker starts
    const blockerInv = await blocker.nextInvocation();

    // Consumer 1 starts
    const consumer1Inv = await consumer1.nextInvocation();

    // Service fails
    serviceInv.exit(1);

    // Consumer 1 is killed
    await consumer1Inv.closed;

    // Blocker unblocks
    blockerInv.exit(0);

    // Consumer 2 can't start becuase the consumer already failed, so wireit
    // exits.
    assert.equal((await wireit.exit).code, 1);
  })
);

test(
  'service shuts down when service dependency exits unexpectedly',
  timeout(async ({rig}) => {
    // consumer
    //    |
    //    v
    // service1
    //    |
    //    v
    // service2

    const consumer = await rig.newCommand();
    const service1 = await rig.newCommand();
    const service2 = await rig.newCommand();
    await rig.writeAtomic({
      'package.json': {
        scripts: {
          consumer: 'wireit',
          service1: 'wireit',
          service2: 'wireit',
        },
        wireit: {
          consumer: {
            command: consumer.command,
            dependencies: ['service1'],
          },
          service1: {
            command: service1.command,
            service: true,
            dependencies: ['service2'],
          },
          service2: {
            command: service2.command,
            service: true,
          },
        },
      },
    });

    const wireit = rig.exec('npm run consumer');

    // Service2 starts
    const service2Inv = await service2.nextInvocation();

    // Service1 starts
    const service1Inv = await service1.nextInvocation();

    // Consumer starts
    const consumerInv = await consumer.nextInvocation();

    // Service 2 exits unexpectedly
    service2Inv.exit(1);
    await wireit.waitForLog(/\[service2\] Service exited unexpectedly/);

    // Consumer killed
    await consumerInv.closed;

    // Service 1 shuts down
    await service1Inv.closed;

    // Wireit exits with an error code
    assert.equal((await wireit.exit).code, 1);
    assert.equal(consumer.numInvocations, 1);
    assert.equal(service1.numInvocations, 1);
    assert.equal(service2.numInvocations, 1);
  })
);

test(
  'directly invoked service and dependency starts and runs until SIGINT',
  // service1
  //    |
  //    v
  // service2
  timeout(async ({rig}) => {
    const service1 = await rig.newCommand();
    const service2 = await rig.newCommand();
    await rig.writeAtomic({
      'package.json': {
        scripts: {
          service1: 'wireit',
          service2: 'wireit',
        },
        wireit: {
          service1: {
            command: service1.command,
            service: true,
            dependencies: ['service2'],
          },
          service2: {
            command: service2.command,
            service: true,
          },
        },
      },
    });

    const wireit = rig.exec('npm run service1');

    // Services start in bottom-up order.
    const service2Inv = await service2.nextInvocation();
    await wireit.waitForLog(/\[service2\] Service started/);
    const service1Inv = await service1.nextInvocation();
    await wireit.waitForLog(/\[service1\] Service started/);

    // Wait a moment to ensure they keep running since the user hasn't killed
    // Wireit yet.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(service1Inv.isRunning);
    assert.ok(service2Inv.isRunning);

    // The user kills Wireit. The services stop in top-down order.
    if (IS_WINDOWS) {
      // We don't get graceful shutdown on Windows.
      wireit.kill();
    } else {
      // Wait a moment after SIGINT to ensure that until service1 actually
      // exits, service2 keeps running.
      const service1SigintReceived = service1Inv.interceptSigint();
      wireit.kill();
      await service1SigintReceived;
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(service1Inv.isRunning);
      assert.ok(service2Inv.isRunning);
      service1Inv.exit(0);
      await wireit.waitForLog(/\[service1\] Service stopped/);
      await wireit.waitForLog(/\[service2\] Service stopped/);
    }
    await service1Inv.closed;
    assert.not(service1Inv.isRunning);
    await service2Inv.closed;
    assert.not(service2Inv.isRunning);

    await wireit.exit;
    assert.equal(service1.numInvocations, 1);
    assert.equal(service2.numInvocations, 1);
  })
);

for (const failureMode of ['continue', 'no-new', 'kill']) {
  // Even directly invoked services which don't have an error in their branch
  // should stop when an error occurs elsewhere, regardless of the error mode.
  // Otherwise wireit won't always exit on failures.
  test(
    `directly invoked service and dependency stop on error ` +
      `with failure mode ${failureMode}`,
    //      entrypoint
    //        /   \
    //       v     v
    // standard   service1
    //  (fails)      |
    //               v
    //            service2
    timeout(async ({rig}) => {
      const standard = await rig.newCommand();
      const service1 = await rig.newCommand();
      const service2 = await rig.newCommand();
      await rig.writeAtomic({
        'package.json': {
          scripts: {
            entrypoint: 'wireit',
            standard: 'wireit',
            service1: 'wireit',
            service2: 'wireit',
          },
          wireit: {
            entrypoint: {
              dependencies: ['standard', 'service1'],
            },
            standard: {
              command: standard.command,
            },
            service1: {
              command: service1.command,
              service: true,
              dependencies: ['service2'],
            },
            service2: {
              command: service2.command,
              service: true,
            },
          },
        },
      });

      const wireit = rig.exec('npm run entrypoint', {
        env: {WIREIT_FAILURES: failureMode},
      });

      // Standard script starts.
      const standardInv = await standard.nextInvocation();

      // Services start in bottom-up order.
      const service2Inv = await service2.nextInvocation();
      await wireit.waitForLog(/\[service2\] Service started/);
      const service1Inv = await service1.nextInvocation();
      await wireit.waitForLog(/\[service1\] Service started/);

      // Wait a moment to ensure they keep running because the failure hasn't
      // happened yet.
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(standardInv.isRunning);
      assert.ok(service1Inv.isRunning);
      assert.ok(service2Inv.isRunning);

      // The standard script fails. The services stop in top-down order.
      if (IS_WINDOWS) {
        // We don't get graceful shutdown in Windows.
        standardInv.exit(1);
      } else {
        // Wait a moment after SIGINT to ensure that until service1 actually
        // exits, service2 keeps running.
        const service1SigintReceived = service1Inv.interceptSigint();
        standardInv.exit(1);
        await service1SigintReceived;
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.ok(service1Inv.isRunning);
        assert.ok(service2Inv.isRunning);
        service1Inv.exit(0);
      }

      await service1Inv.closed;
      assert.not(service1Inv.isRunning);
      await wireit.waitForLog(/\[service1\] Service stopped/);
      await service2Inv.closed;
      assert.not(service2Inv.isRunning);
      await wireit.waitForLog(/\[service2\] Service stopped/);

      await wireit.exit;
      assert.equal(standard.numInvocations, 1);
      assert.equal(service1.numInvocations, 1);
      assert.equal(service2.numInvocations, 1);
    })
  );
}

test(
  'indirectly invoked service shuts down between watch iterations',
  timeout(async ({rig}) => {
    // consumer
    //    |
    //    v
    // service

    const consumer = await rig.newCommand();
    const service = await rig.newCommand();
    await rig.writeAtomic({
      'package.json': {
        scripts: {
          consumer: 'wireit',
          service: 'wireit',
        },
        wireit: {
          consumer: {
            command: consumer.command,
            dependencies: ['service'],
            files: ['input'],
          },
          service: {
            command: service.command,
            service: true,
          },
        },
      },
    });

    await rig.write('input', '0');
    const wireit = rig.exec('npm run consumer --watch');

    // Iteration 1
    {
      const serviceInv = await service.nextInvocation();
      const consumerInv = await consumer.nextInvocation();
      consumerInv.exit(0);
      await consumerInv.closed;
      await serviceInv.closed;
    }

    await rig.write('input', '1');

    // Iteration 2
    {
      const serviceInv = await service.nextInvocation();
      const consumerInv = await consumer.nextInvocation();
      consumerInv.exit(0);
      await consumerInv.closed;
      await serviceInv.closed;
    }

    wireit.kill();
    await wireit.exit;
    assert.equal(consumer.numInvocations, 2);
    assert.equal(service.numInvocations, 2);
  })
);

test(
  'directly invoked service is preserved across watch iterations',
  timeout(async ({rig}) => {
    //     entrypoint
    //     /        \
    //    v          v
    // service    standard

    const service = await rig.newCommand();
    const standard = await rig.newCommand();
    await rig.writeAtomic({
      'package.json': {
        scripts: {
          entrypoint: 'wireit',
          service: 'wireit',
          standard: 'wireit',
        },
        wireit: {
          entrypoint: {
            dependencies: ['service', 'standard'],
          },
          service: {
            command: service.command,
            service: true,
          },
          standard: {
            command: standard.command,
            files: ['input'],
          },
        },
      },
    });

    await rig.write('input', '0');
    const wireit = rig.exec('npm run entrypoint --watch');

    // Iteration 1
    {
      await service.nextInvocation();
      const standardInv = await standard.nextInvocation();
      standardInv.exit(0);
      await standardInv.closed;
    }

    await rig.write('input', '1');

    // Iteration 2
    {
      const standardInv = await standard.nextInvocation();
      standardInv.exit(0);
      await standardInv.closed;
    }

    wireit.kill();
    await wireit.exit;
    assert.equal(service.numInvocations, 1);
    assert.equal(standard.numInvocations, 2);
  })
);

test(
  'deleted service shuts down between watch iterations',
  timeout(async ({rig}) => {
    //      entrypoint
    //        /   \
    //       v     v
    // standard   service (gets deleted)

    const standard = await rig.newCommand();
    const service = await rig.newCommand();
    await rig.writeAtomic({
      'package.json': {
        scripts: {
          entrypoint: 'wireit',
          standard: 'wireit',
          service: 'wireit',
        },
        wireit: {
          entrypoint: {
            dependencies: ['standard', 'service'],
          },
          standard: {
            command: standard.command,
          },
          service: {
            command: service.command,
            service: true,
          },
        },
      },
    });

    // Iteration 1. Both scripts start.
    const wireit = rig.exec('npm run entrypoint --watch');
    const serviceInv = await service.nextInvocation();
    const standardInv1 = await standard.nextInvocation();
    standardInv1.exit(0);
    await wireit.waitForLog(/Watching for file changes/);

    // Iteration 2. We update the config to delete the service. It should get
    // shut down.
    await rig.writeAtomic({
      'package.json': {
        scripts: {
          entrypoint: 'wireit',
          standard: 'wireit',
        },
        wireit: {
          entrypoint: {
            dependencies: ['standard'],
          },
          standard: {
            command: standard.command,
          },
        },
      },
    });
    await serviceInv.closed;
    const standardInv2 = await standard.nextInvocation();
    standardInv2.exit(0);
    await wireit.waitForLog(/Watching for file changes/);

    wireit.kill();
    await wireit.exit;
    assert.equal(service.numInvocations, 1);
    assert.equal(standard.numInvocations, 2);
  })
);

test.run();
