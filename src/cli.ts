const main = async () => {
  const cmd = process.argv[2];
  const tail = process.argv.slice(3);
  try {
    if (cmd === 'analyze') {
      await (await import('./commands/analyze.js')).default(tail);
    } else if (
      cmd === 'run' ||
      (cmd === undefined && process.env.npm_lifecycle_event)
    ) {
      await (await import('./commands/run.js')).default(tail);
    } else {
      console.error('Valid commmands are: analyze, run');
      process.exit(1);
    }
  } catch (e) {
    console.error(`Command ${cmd} failed`);
    console.error((e as Error).message);
    process.exit(1);
  }
};

main();
