/**
 * Reading the command's inputs from disk: definitions with their sidecar test files, extra test
 * files and a sandbox program. Anything wrong with an input is an `InputError` (exit 2) that names the file and why, so a CI log says what to fix without a stack.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

import type { FormDefinition } from "@argusvane/datum-engine/core";

import type { FormTestSource, FormTestsInput, ProgramInput } from "./api.js";

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const why = code === "ENOENT" ? "no such file" : code === "EISDIR" ? "it is a folder" : error instanceof Error ? error.message : String(error);
    throw new InputError(`cannot read the ${what} ${path}: ${why}`);
  }
}

/**
 * The sidecar a definition's tests may sit in: the definition's path with
 * its extension replaced by `.datum-test`, so `forms/intake.json` reads `forms/intake.datum-test`.
 */
export function sidecarPathOf(definitionPath: string): string {
  const extension = extname(definitionPath);
  const stem = extension === "" ? definitionPath : definitionPath.slice(0, -extension.length);
  return `${stem}.datum-test`;
}

export function loadTestFile(path: string): FormTestSource {
  return { path, text: readText(path, "test file") };
}

/**
 * A definition file: JSON holding an object with an object `root` (the least the engine can
 * build a form from), plus its sidecar when one exists. The definition's own `tests` are read
 * later (`readFormTests`), tolerantly, as every host reads them.
 */
export function loadDefinitionFile(path: string): FormTestsInput {
  const text = readText(path, "definition");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new InputError(`the definition ${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new InputError(`the definition ${path} is not a form definition: it is not a JSON object`);
  }
  if (!isRecord(parsed.root)) {
    throw new InputError(`the definition ${path} is not a form definition: it has no "root" component object`);
  }
  const sidecar = sidecarPathOf(path);
  const sources: FormTestSource[] = [];
  if (sidecar !== path && existsSync(sidecar) && statSync(sidecar).isFile()) {
    sources.push(loadTestFile(sidecar));
  }
  return { definition: parsed as unknown as FormDefinition, path, sources };
}

export function loadProgramFile(path: string): ProgramInput {
  const text = readText(path, "sandbox program");
  if (text.trim() === "") {
    throw new InputError(`the sandbox program ${path} is empty`);
  }
  return { path, text };
}

function labelText(label: unknown): string | undefined {
  if (typeof label === "string") {
    return label === "" ? undefined : label;
  }
  if (isRecord(label) && typeof label.default === "string" && label.default !== "") {
    return label.default;
  }
  return undefined;
}

/**
 * The form's title for a report heading. `FormDefinition` has no `title` key: the form's name as
 * a reader sees it is the root component's `configuration.label` (a string or a localized text,
 * read in its default), then `metadata.name`. A `title` string some hosts store beside the
 * definition is read first.
 */
export function titleOf(definition: FormDefinition): string | undefined {
  const raw = definition as unknown as Record<string, unknown>;
  if (typeof raw.title === "string" && raw.title !== "") {
    return raw.title;
  }
  const root = raw.root;
  const configuration = isRecord(root) && isRecord(root.configuration) ? root.configuration : undefined;
  const label = labelText(configuration?.label);
  if (label !== undefined) {
    return label;
  }
  const metadata = raw.metadata;
  return isRecord(metadata) && typeof metadata.name === "string" && metadata.name !== "" ? metadata.name : undefined;
}
