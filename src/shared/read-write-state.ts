import * as path from "path";
import * as fs from "fs/promises";

import type { State } from "../types/state.js";

export const readState = async (root: string): Promise<State | undefined> => {
  const statePath = path.join(root, ".wireit", "state.json");
  let stateStr;
  try {
    stateStr = await fs.readFile(statePath, "utf8");
  } catch (e) {
    const code = (e as { code: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw e;
  }
  const state = JSON.parse(stateStr) as State;
  return state;
};

export const writeState = async (root: string, state: State): Promise<void> => {
  const stateDir = path.join(root, ".wireit");
  await fs.mkdir(stateDir, { recursive: true });
  const statePath = path.join(stateDir, "state.json");
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
};
