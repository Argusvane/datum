import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CliIo } from "../../src/cli.js";

/** An io that keeps what the command prints, as the conformance suite's tests do. */
export function capture(): { io: CliIo; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return { io: { stdout: (text) => void (out += text), stderr: (text) => void (err += text) }, out: () => out, err: () => err };
}

/** A temporary folder for one test file, with a helper that writes a file into it and answers its path. */
export function workFolder(prefix: string): { dir: string; file: (name: string, text: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    file: (name, text) => {
      const path = join(dir, name);
      writeFileSync(path, text);
      return path;
    }
  };
}
