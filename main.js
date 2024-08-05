/**
 * @license
 * Copyright 2024 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { fork } from "node:child_process";
import { join } from "node:path";

console.log("[main] Launching background custodian service");
const server = fork(join(import.meta.dirname, "custodian.js"), {
  detached: true,
  stdio: "inherit",
});

server.on("message", (status) => {
  console.log("[main] Received status from custodian service", status);
  process.exit(status);
});
