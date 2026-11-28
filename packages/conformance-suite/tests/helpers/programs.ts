import { buildSandboxProgram } from "@argusvane/datum-quickjs-wasm-host";

import { programFromText, type LoadedProgram } from "../../src/runners/program/load-program.js";

let built: string | undefined;

/** The program built from the engine's source: how the repository's own tests get one (vitest runs the Vite SSR transform buildSandboxProgram handles). */
export function builtProgramText(): string {
  built ??= buildSandboxProgram();
  return built;
}

export function builtProgram(): LoadedProgram {
  return programFromText(builtProgramText(), "(built from source)", "built");
}

/** Replaces text and fails the test setup loudly when the program no longer contains it (so a negative program cannot silently stay valid). */
function mustReplace(text: string, pattern: RegExp | string, replacement: string, what: string): string {
  const out = text.replace(pattern, replacement);
  if (out === text) {
    throw new Error(`negative program "${what}": the built program does not contain the text to change`);
  }
  return out;
}

/**
 * (1) A yes-man: the real program with `__datum_run` replaced by one that finds nothing wrong. The program publishes its
 * entry points non-writable and non-configurable (`__datum_publish`), so the function is swapped before it is published.
 */
export function yesManProgramText(): string {
  return mustReplace(builtProgramText(), "var __datum_run = function (serializedContext) {", "var __datum_run = function () { return '{\"errors\":[]}'; };\n  var __datum_run_real = function (serializedContext) {", "yes-man entry point");
}

/** (2) The real program whose ABI answer says 0.9.0: a stale build. */
export function staleAbiProgramText(): string {
  return mustReplace(builtProgramText(), /(function kernelInspectAbi\(\)\s*\{\s*return )"\d+\.\d+\.\d+"/, '$1"0.9.0"', "ABI rewritten to 0.9.0");
}

/** (3) The real program without its Math.random / Date hardening. */
export function noHardeningProgramText(): string {
  return mustReplace(builtProgramText(), /\(function \(\) \{\s*Math\.random = [\s\S]*?globalThis\.Date = ThrowingDate;\s*\}\)\(\);/, "", "hardening removed");
}

/**
 * Wraps one of the program's entry points: its published value becomes `wrapper(original)`, evaluated inside the
 * program's closure. The program publishes `__datum_register`, `__datum_run` and `__datum_inspect` non-writable and
 * non-configurable from inside one closure (sandbox-program.ts), so a test double cannot reassign them afterwards.
 */
export function wrapEntryPoint(program: string, entry: "__datum_run" | "__datum_inspect", wrapper: string): string {
  const pattern = new RegExp(`__datum_publish\\("${entry}", (.*)\\);$`, "m");
  const oneLine = wrapper.replace(/\s*\n\s*/g, " ");
  return mustReplace(program, pattern, `__datum_publish("${entry}", (${oneLine.replace(/\$/g, "$$$$")})($1));`, `${entry} wrapped`);
}

/**
 * (4) The real program with some kernel functions replaced: the guarded behaviour removed, everything else the real
 * thing. The kernel lives in one closure, so a replacement is a second declaration of the same name inside it (the later
 * declaration of a function name in one scope wins, and every call by the bare name and through the kernel scope object
 * sees it). Each replacement is a `function (...) {...}` expression. The helper throws when a named function is no
 * longer in the program.
 */
export function mutantProgramText(replacements: Record<string, string>): string {
  const program = builtProgramText();
  const marker = "  var __datum_cache_chars = ";
  if (!program.includes(marker)) {
    throw new Error("mutant program: the built program no longer has the line the replacements are placed before; update mutantProgramText");
  }
  const declarations: string[] = [];
  for (const [name, expression] of Object.entries(replacements)) {
    if (!program.includes(`function ${name}(`)) {
      throw new Error(`mutant program: the built program has no function ${name}`);
    }
    if (!/^function\s*\(/.test(expression)) {
      throw new Error(`mutant program: the replacement for ${name} must be a function expression`);
    }
    declarations.push(expression.replace(/^function\s*\(/, `function ${name}(`));
  }
  return program.replace(marker, `${declarations.join("\n")}\n${marker}`);
}

/** Mutants for the S1 option checks and a few guards the other packs pin. Each removes one thing. */
export const MUTANTS = {
  /** No choice answer is ever checked against its options. */
  noOptionCheck: (): string => mutantProgramText({ kernelCheckOptions: "function () { return []; }" }),
  /** A partition that keeps rows and container objects whole, never reading them as the flat keys they stand for. */
  storedWhole: (): string =>
    mutantProgramText({
      kernelPartitionValues:
        "function (values) { var known = {}; var keys = Object.keys(values); for (var i = 0; i < keys.length; i += 1) { known[keys[i]] = values[keys[i]]; } return { known: known, unknownKeys: [], superseded: [] }; }"
    }),
  /** Any truthy answersFree frees a source ("true", 1, "yes"), not only the boolean true. */
  truthyAnswersFree: (): string =>
    mutantProgramText({ kernelOptionSourceFree: "function (configuration) { var data = configuration && configuration.data; return !!(data && data.answersFree); }" }),
  /** The 32-level component cap is gone. */
  noDepthCap: (): string => mutantProgramText({ kernelComponentTooDeep: "function () { return undefined; }" }),
  /** server-secret rules are served in the public definition. */
  secretsServed: (): string => mutantProgramText({ kernelStripSecretRules: "function (root) { return root; }", kernelPublicDefinition: "function (definition) { return definition; }" }),
  /** Any component sharing a storage key stands in for a sourced choice. */
  anySharerStandsAside: (): string => mutantProgramText({ kernelOptionIsPlainText: "function () { return true; }" }),
  /** The 10,000-character cap on whole-text formula functions is gone. */
  noTextCap: (): string => mutantProgramText({ kernelTextOverCap: "function () { return false; }" }),
  /** The outcome is plain JSON, not the canonical text. */
  plainJson: (): string => mutantProgramText({ kernelStableStringify: "function (value) { return JSON.stringify(value); }" })
} as const;
