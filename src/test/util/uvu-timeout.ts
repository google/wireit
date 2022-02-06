import type * as uvu from 'uvu';

const DEFAULT_TIMEOUT = 30000;

export const timeout = <T>(
  handler: uvu.Callback<T>,
  ms = DEFAULT_TIMEOUT
): uvu.Callback<T> => {
  return async (...args) => {
    let timerId: ReturnType<typeof setTimeout>;
    return Promise.race([
      handler(...args),
      new Promise<never>((_resolve, reject) => {
        timerId = setTimeout(
          () => reject(new Error(`Test timed out after ${ms} milliseconds.`)),
          ms
        );
      }),
    ]).finally(() => {
      clearTimeout(timerId);
    });
  };
};
