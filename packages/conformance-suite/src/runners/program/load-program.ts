import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface LoadedProgram {
  /** `file` for a path the operator gave, `built` for a program the repository script built from source. */
  source: "file" | "built";
  path: string;
  text: string;
  bytes: number;
  sha256: string;
  /** The ABI the banner comment claims. A hint only: ABI detection never trusts it. */
  bannerAbi?: string;
}

const BANNER = /Datum sandbox program \(ABI (\d+\.\d+\.\d+)\)/;

export function programFromText(text: string, path: string, source: "file" | "built"): LoadedProgram {
  const bytes = Buffer.byteLength(text, "utf8");
  const banner = BANNER.exec(text.slice(0, 2000));
  return {
    source,
    path,
    text,
    bytes,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    ...(banner?.[1] !== undefined ? { bannerAbi: banner[1] } : {})
  };
}

export class ProgramLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramLoadError";
  }
}

/** Reads a program file. A missing or empty file is a usage error (exit 2), not a FAIL. */
export function loadProgram(path: string): LoadedProgram {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ProgramLoadError(`cannot read the program file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (text.trim() === "") {
    throw new ProgramLoadError(`the program file ${path} is empty`);
  }
  return programFromText(text, path, "file");
}
