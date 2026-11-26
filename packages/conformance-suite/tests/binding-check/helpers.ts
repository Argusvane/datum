import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";

import { PACKAGE_ROOT } from "../helpers/paths.js";

const exec = promisify(execFile);

export const BIN = join(PACKAGE_ROOT, "bin", "datum-binding-check.mjs");

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `datum-binding-check` (or another copy of the shim) and resolves to its exit code and output, whatever the code. */
export async function runCommand(args: string[], options: { bin?: string; cwd?: string; env?: Record<string, string> } = {}): Promise<CommandResult> {
  try {
    const done = await exec(process.execPath, [options.bin ?? BIN, ...args], {
      cwd: options.cwd ?? PACKAGE_ROOT,
      env: { ...process.env, NODE_PATH: "", ...options.env },
      maxBuffer: 64 * 1024 * 1024
    });
    return { code: 0, stdout: done.stdout, stderr: done.stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failed.code === "number" ? failed.code : -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

/** Whether Playwright is installed here and has a Chromium to launch (CI installs the suite's packages but no browser). */
export function hasChromium(): boolean {
  try {
    const playwright = createRequire(join(PACKAGE_ROOT, "package.json"))("playwright") as { chromium: { executablePath(): string } };
    return existsSync(playwright.chromium.executablePath());
  } catch {
    return false;
  }
}

/** A port for a browser run: the one the environment names (a fixed range on a shared machine), else any free one. */
export const TEST_PORT = process.env["BINDING_CHECK_TEST_PORT"] ?? "0";
