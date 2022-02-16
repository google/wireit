import {KnownError} from './shared/known-error.js';

const main = async () => {
  const args = process.argv.slice(2);
  const cmd = args[0] && !args[0].startsWith('--') ? args.shift() : 'run';

  const abort = new Promise<void>((resolve) => {
    process.on('SIGINT', async () => {
      resolve();
    });
  });

  try {
    if (cmd === 'run') {
      const module = await import('./commands/run.js');
      await module.default(args, abort);
    } else if (cmd === 'watch') {
      const module = await import('./commands/watch.js');
      await module.default(args, abort);
    } else {
      console.error('❌ Valid commmands are: run, watch');
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`❌ Command ${cmd} failed`);
    const errors = error instanceof AggregateError ? error.errors : [error];
    for (const e of errors) {
      console.error('❌' + (e as Error).message);
      if (!(e instanceof KnownError)) {
        console.error((e as Error).stack);
      }
    }
    process.exitCode = 1;
  }
};

main();
