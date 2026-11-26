import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { BuilderHostName } from "./builder-types.js";

/**
 * The run state file (`--state-file`, default `./.datum-security-run.json`). It is written BEFORE
 * the first request that can create the suite form, so a run that is killed (power, SIGKILL) still
 * leaves the id the operator needs: `datum-security-check builder-cleanup` reads it. It holds ids
 * and hashes, never credentials.
 */
export interface RunState {
  version: 1;
  runId: string;
  host: BuilderHostName;
  baseUrl: string;
  formId: string;
  formVersion: string;
  mode: "create" | "adopt";
  phase: "creating" | "created" | "cleaning" | "cleaned";
  startedAt: string;
  /** Adopt mode: the definition (as JSON text) and hash the form had before the run, for the restore. */
  original?: { text: string; hash: string };
  /** Submissions: every catalogue key the run registered (hostile versions are other keys). */
  keys?: string[];
  recordsCreated: number;
}

export function writeState(path: string, state: RunState): void {
  mkdirSync(dirname(path) || ".", { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function readState(path: string): RunState | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RunState>;
    if (parsed.version === 1 && typeof parsed.formId === "string" && parsed.host === "submissions" && typeof parsed.baseUrl === "string") {
      return parsed as RunState;
    }
  } catch {
    // An unreadable file is reported as absent; the caller says so.
  }
  return undefined;
}

export function removeState(path: string): void {
  rmSync(path, { force: true });
}
