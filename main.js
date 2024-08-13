/**
 * @license
 * Copyright 2024 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from "node:child_process";
import { mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

console.log("[main] Launching background custodian service");

const scriptPath = join(import.meta.dirname, "custodian.js");
const logDir = mkdtempSync(join(tmpdir(), "wireit_custodian_logs_"));
console.log("[main] Writing logs to", logDir);
const outPath = join(logDir, "stdout.log");
const errPath = join(logDir, "stderr.log");

let child;
if (process.platform === "win32") {
  child = spawn(
    // Use `start` so that the server is not killed when our parent shell exits.
    // https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/start
    //
    // Under Windows, `{detached: true}` is not sufficient for keeping the
    // server alive after the parent shell exits. The parent shell will exit
    // after this main script is done, because this action is invoked through a
    // GitHub Actions `uses:` clause (as opposed to `run:` where we would be
    // sharing our parent shell with subsequent steps).
    "start",
    [
      // Don't create a new Command Prompt window.
      "/b",
      // Spawn a shell so that we can do I/O redirection.
      "cmd",
      "/c",
      // Note `^` is the escape sequence for cmd.exe.
      `node "${scriptPath}" ^> "${outPath}" 2^> "${errPath}"`,
    ],
    {
      // We need an outer shell too, because `start` is a cmd.exe builtin, not
      // an executable.
      shell: true,
      detached: true,
      stdio: "ignore",
    }
  );
} else {
  // Under Linux and macOS, `{detached: true}` is sufficient for keeping the
  // server alive after the parent shell exits.
  child = spawn("node", [scriptPath], {
    detached: true,
    stdio: ["ignore", openSync(outPath, "w"), openSync(errPath, "w")],
  });
}

await new Promise((resolve) => child.once("spawn", resolve));
child.unref();

// Poll the server logs until it's ready. We could do something fancier with
// some kind of IPC, but this is much simpler (especially with Windows in the
// mix), plus it's nice to just dump all of the stdout/stderr in case something
// unexpected happens.
const timeoutSecs = 30;
const pollMillis = 100;
const start = Date.now();
let stdout, stderr;
while (true) {
  await new Promise((resolve) => setTimeout(resolve, pollMillis));
  stdout = readFileSync(outPath, "utf8");
  stderr = readFileSync(errPath, "utf8");
  if (stdout.match(/Listening on port/) !== null) {
    console.error(stderr);
    console.log(stdout);
    console.log(`[main] Custodian server ready`);
    process.exit(0);
  }
  if (Date.now() - start > timeoutSecs * 1000) {
    console.error(stderr);
    console.log(stdout);
    console.log(
      `[main] Timed out waiting for custodian server to be ready (${timeoutSecs} seconds)`
    );
    process.exit(1);
  }
}
