import {KnownError} from '../shared/known-error.js';
import {findNearestPackageJson} from '../shared/nearest-package-json.js';
import {FilesystemCache} from '../shared/filesystem-cache.js';
import {GitHubCache} from '../shared/github-cache.js';
import mri from 'mri';
import {ScriptRunner} from '../shared/script-runner.js';
import {DefaultLogger} from '../shared/default-logger.js';

const parseArgs = (
  args: string[]
): {scriptName: string; parallel: number; failFast: boolean} => {
  // TODO(aomarks) Add validation.
  const parsed = mri(args);
  return {
    scriptName: parsed._[0] ?? process.env.npm_lifecycle_event,
    parallel: parsed['parallel'] ?? Infinity,
    failFast: parsed['fail-fast'] ?? false,
  };
};

export default async (args: string[], abort: Promise<void>) => {
  const {scriptName, parallel, failFast} = parseArgs(args);

  // We could check process.env.npm_package_json here, but it's actually wrong
  // in some cases. E.g. when we invoke wireit from one npm script, but we're
  // asking it to evaluate another directory.
  const packageJsonPath = await findNearestPackageJson(process.cwd());
  if (packageJsonPath === undefined) {
    throw new KnownError(
      'invalid-argument',
      `Could not find a package.json in ${process.cwd()} or parents`
    );
  }

  const cache = process.env.GITHUB_CACHE
    ? new GitHubCache()
    : new FilesystemCache();
  const logger = new DefaultLogger();
  const runner = new ScriptRunner(abort, cache, parallel, failFast, logger);
  await runner.run({packageJsonPath, scriptName});
};
