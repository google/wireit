import {KnownError} from './shared/known-error.js';
import {AbortManager} from './shared/aborted.js';

const main = async () => {
  const args = process.argv.slice(2);
  const cmd = args[0] ? args.shift() : 'run';
  const abort = new AbortManager();
  process.on('SIGINT', async () => {
    await abort.abort();
    process.exit(1);
  });
  try {
    if (cmd === 'run') {
      await (await import('./commands/run.js')).default(args, abort);
    } else if (cmd === 'watch') {
      await (await import('./commands/watch.js')).default(args, abort);
    } else {
      console.error('Valid commmands are: run, watch');
      process.exit(1);
    }
  } catch (e) {
    console.error(`Command ${cmd} failed`);
    console.error((e as Error).message);
    if (!(e instanceof KnownError)) {
      console.error((e as Error).stack);
    }
    process.exit(1);
  }
};

main();
