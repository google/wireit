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

test.run();
