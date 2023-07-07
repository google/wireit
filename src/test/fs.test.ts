import {Semaphore} from '../util/fs.js';
import {test} from 'uvu';
import * as assert from 'uvu/assert';

async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('Semaphore restricts resource access', async () => {
  const semaphore = new Semaphore(1);
  const reservation1 = await semaphore.reserve();
  const reservation2Promise = semaphore.reserve();
  let hasResovled = false;
  reservation2Promise.then(() => {
    hasResovled = true;
  });
  // Wait a bit to make sure the promise has had a chance to resolve.
  await wait(100);
  // The semaphore doesn't let the second reservation happen yet, it would
  // be over budget.
  assert.is(hasResovled, false);
  reservation1[Symbol.dispose]();
  // Now it can happen.
  await reservation2Promise;
});

test('Semaphore reservation happens immediately when not under contention', async () => {
  const semaphore = new Semaphore(3);
  await semaphore.reserve();
  await semaphore.reserve();
  await semaphore.reserve();
});

test.run();
