/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {timeout} from './util/uvu-timeout.js';
import {WireitTestRig} from './util/test-rig.js';

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

test.run();
