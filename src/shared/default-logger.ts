import {Event} from './events.js';
import {loggableName} from './loggable-name.js';
import {unreachable} from './unreachable.js';

export class DefaultLogger {
  log(event: Event) {
    const type = event.type;
    const name = loggableName(
      event.script.packageJsonPath,
      event.script.scriptName
    );
    const prefix = `[${name}]`;
    switch (type) {
      default: {
        throw new Error(`Unknown event: ${unreachable(type)}`);
      }
      case 'success': {
        const reason = event.reason;
        switch (reason) {
          default: {
            throw new Error(`Unknown success reason: ${unreachable(reason)}`);
          }
          case 'fresh': {
            console.log(`🥬 ${prefix} Already fresh`);
            break;
          }
          case 'no-command': {
            console.log(`✅ ${prefix} Completed (no command)`);
            break;
          }
          case 'cache-hit': {
            console.log(`♻️ ${prefix} Restored from cache`);
            break;
          }
          case 'exit-zero': {
            console.log(`✅ ${prefix} Executed successfully`);
            break;
          }
        }
        break;
      }
      case 'failure': {
        const reason = event.reason;
        switch (reason) {
          default: {
            throw new Error(`Unknown failure reason: ${unreachable(reason)}`);
          }
          case 'start-error': {
            console.log(`❌ ${prefix} Failed to start: ${event.message}`);
            break;
          }
          case 'exit-non-zero': {
            console.log(`❌ ${prefix} Failed with code ${event.code}`);
            break;
          }
          case 'interrupt': {
            if (event.intentional) {
              console.log(
                `❎ ${prefix} Was successfully killed with signal ${event.signal}`
              );
            } else {
              console.log(
                `❌ ${prefix} Unexpectedly exited due to signal ${event.signal}`
              );
            }
            break;
          }
        }
        break;
      }
      case 'output': {
        const stream = event.stream;
        switch (stream) {
          default: {
            throw new Error(`Unknown output stream: ${unreachable(stream)}`);
          }
          case 'stdout': {
            process.stdout.write(event.data);
            break;
          }
          case 'stderr': {
            process.stderr.write(event.data);
            break;
          }
        }
        break;
      }
      case 'dependencies-pending': {
        console.log(`🔗 ${prefix} Waiting for dependencies to resolve`);
        break;
      }
      case 'dependencies-resolved': {
        console.log(`🏁 ${prefix} Dependencies resolved`);
        break;
      }
      case 'cache-miss': {
        console.log(`📂 ${prefix} Cache miss`);
        break;
      }
      case 'parallel-contention': {
        console.log(`💤 ${prefix} Waiting for another script to finish`);
        break;
      }
      case 'output-deleted': {
        console.log(`🗑️ ${prefix} ${event.numDeleted} output files deleted`);
        break;
      }
      case 'incremental-delegation': {
        console.log(`🔁 ${prefix} Using incremental build file`);
        break;
      }
      case 'spawn': {
        console.log(`🏃 ${prefix} Running command`);
        break;
      }
      case 'cache-save': {
        console.log(`💾 ${prefix} Cache saved`);
        break;
      }
      case 'killing': {
        console.log(`💀 ${prefix} Killing`);
        break;
      }
    }
  }
}
