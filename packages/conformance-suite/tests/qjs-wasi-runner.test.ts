import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FREEZE_INTRINSICS_SNIPPET } from "@argusvane/datum-quickjs-wasm-host";
import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { BASE_FORM_ID } from "../src/fixtures/base-form.js";
import { buildRoot } from "../src/fixtures/builders.js";
import { CONTROL_VALUES } from "../src/fixtures/controls.js";
import { runSuite } from "../src/run.js";
import { framed, hasStrayOutput, loadQjsWasiModule, marker, QjsWasiLoadError, REMOVED_GLOBALS, runScript, type QjsWasiModule } from "../src/runners/program/qjs-wasi.js";
import { linearMemoryBytes } from "../src/runners/program/qjs-wasi-host.js";
import { ProgramSession, StartupError } from "../src/runners/program/session.js";
import { REPO_ROOT } from "./helpers/paths.js";
import { builtProgram, builtProgramText } from "./helpers/programs.js";

// The module the FastAPI host packages, fetched and checked against runtime.json by `npm run fastapi:assets` (or
// `node integrations/fastapi/scripts/fetch-runtime.mjs`); CI's conformance-suite job fetches it first.
const PIN = JSON.parse(readFileSync(join(REPO_ROOT, "integrations/fastapi/packages/argusvane-datum-qjs-wasm/src/datum_qjs_wasm/runtime.json"), "utf8")) as { sha256: string; size: number };
const WASM = join(REPO_ROOT, "integrations/fastapi/packages/argusvane-datum-qjs-wasm/src/datum_qjs_wasm/qjs-wasi.wasm");
const haveWasm = existsSync(WASM);
// Without the module the engine tests cannot run; on CI that is a failure, never a skip.
const withWasm = haveWasm || process.env["CI"] ? describe : describe.skip;

const NONCE = "0123456789abcdef0123456789abcdef";
const frame = (answer: string, before = "", after = ""): Buffer => Buffer.from(`${before}${marker(NONCE, "started")}\n${marker(NONCE, "begin")}\n${answer}\n${marker(NONCE, "end")}\n${after}`);

describe("the run script and the answer frame of the server hosts", () => {
  it("removes the globals the FastAPI and JVM run scripts remove, in their order", () => {
    const python = readFileSync(join(REPO_ROOT, "integrations/fastapi/packages/argusvane-datum-sandbox/src/datum_sandbox/protocol/_run_script.py"), "utf8");
    const java = readFileSync(join(REPO_ROOT, "integrations/jvm/libs/datum-sandbox/src/main/java/com/argusvane/datum/sandbox/protocol/RunScript.java"), "utf8");
    const listed = REMOVED_GLOBALS.map((name) => `"${name}"`).join(", ");
    expect(python).toContain(`REMOVED_GLOBALS: Final = (${listed})`);
    expect(java).toContain(`REMOVED_GLOBALS = List.of(${listed})`);
  });

  it("captures the entry point, removes the globals, freezes, marks the start, then registers each module as an ASCII literal and answers in the frame", () => {
    const script = runScript(FREEZE_INTRINSICS_SNIPPET, [{ id: "rules", version: "1.0.0", source: `({ validators: [] }) // ${String.fromCharCode(0xe9)} ${String.fromCharCode(0x2028)}` }], "run");
    const order = ["var entry = globalThis.__datum_run;", "delete globalThis[name];", FREEZE_INTRINSICS_SNIPPET.split("\n")[0]!, 'print(mark("started"));', "  // rules@1.0.0", "register(evaluate(", "var answer = entry(input);", 'print(mark("begin"));', 'print(mark("end"));'];
    const at = order.map((line) => script.indexOf(line));
    expect(at.every((index) => index >= 0), order.filter((_, index) => at[index]! < 0).join(" | ")).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The source's e-acute and line separator reach the script as escapes, so the registration stays one ASCII line.
    const registration = script.split("\n").find((line) => line.includes("register(evaluate(")) ?? "";
    expect(registration).toBe(String.raw`  register(evaluate("(\n({ validators: [] }) // \u00e9 \u2028\n)"));`);
    expect(runScript(FREEZE_INTRINSICS_SNIPPET, [], "inspect")).toContain("var entry = globalThis.__datum_inspect;");
    expect(runScript(FREEZE_INTRINSICS_SNIPPET, [], "run")).toContain("var getNames = Object.getOwnPropertyNames;");
    expect(runScript(undefined, [], "run")).not.toContain("var getNames = Object.getOwnPropertyNames;");
    expect(runScript(FREEZE_INTRINSICS_SNIPPET, [], "startup")).toContain('var entry = function () { return "null"; };');
  });

  it("reads exactly one frame of the run's nonce and refuses anything else", () => {
    expect(framed(frame('{"errors":[]}'), NONCE)?.toString()).toBe('{"errors":[]}');
    expect(framed(frame("{}", " \n", "\r\n\t"), NONCE)?.toString()).toBe("{}");
    // A line before the frame, after it, or a marker inside the answer: no answer.
    expect(framed(frame("{}", "stray\n"), NONCE)).toBeUndefined();
    expect(framed(frame("{}", "", "stray"), NONCE)).toBeUndefined();
    expect(framed(frame(`${marker(NONCE, "end")}{}`), NONCE)).toBeUndefined();
    expect(framed(frame("{}"), "f".repeat(32))).toBeUndefined();
    expect(framed(Buffer.from(`${marker(NONCE, "started")}\n`), NONCE)).toBeUndefined();
    expect(hasStrayOutput(frame("{}", "", "stray"), NONCE)).toBe(true);
    expect(hasStrayOutput(Buffer.from(marker(NONCE, "started")), NONCE)).toBe(false);
  });

  it("holds the module to its pin before anything compiles it", () => {
    const dir = mkdtempSync(join(tmpdir(), "datum-qjs-wasi-pin-"));
    const file = join(dir, "qjs-wasi.wasm");
    writeFileSync(file, "not the module");
    const sha256 = createHash("sha256").update("not the module").digest("hex");
    expect(loadQjsWasiModule(file, { sha256 }).size).toBe(14);
    expect(() => loadQjsWasiModule(file, { sha256: "0".repeat(64) })).toThrow(QjsWasiLoadError);
    expect(() => loadQjsWasiModule(file, { sha256, size: 15 })).toThrow(/14 bytes; the pinned qjs-wasi.wasm is 15/);
    expect(() => loadQjsWasiModule(file, { sha256: "short" })).toThrow(/64 hex characters/);
    expect(() => loadQjsWasiModule(join(dir, "absent.wasm"), { sha256 })).toThrow(/cannot read/);
  });

  it("caps the linear memory at the vector's heap and 32 MiB more", () => {
    expect(linearMemoryBytes()).toBe(64 * 1024 * 1024);
    expect(linearMemoryBytes(4 * 1024 * 1024)).toBe(36 * 1024 * 1024);
  });
});

withWasm("the program on qjs-wasi.wasm", () => {
  const engine = (): QjsWasiModule => loadQjsWasiModule(WASM, PIN);
  const open = (options: Partial<Parameters<typeof ProgramSession.open>[0]> = {}) => ProgramSession.open({ program: builtProgramText(), engine: engine(), ...options });

  it("answers an inspect and a run as the servers do, each call on a fresh instance", async () => {
    const session = await open();
    try {
      const answer = await session.inspect(JSON.stringify({ abi: "4.0.0", op: "public", definition: { root: { id: "form", type: "form" } } }));
      expect(answer.observation.kind).toBe("answer");
      expect((answer.observation as { json: { ok?: unknown } }).json.ok).toBe(true);
      const run = await session.run("{");
      expect(run.observation).toMatchObject({ kind: "refusal", code: "runtime_error" });
      expect((run.observation as { detail: string }).detail).toMatch(/SyntaxError/);
    } finally {
      session.dispose();
    }
  });

  it("stops a run at its budget, counted from the started marker, and a module that is not one before any call", async () => {
    const looping = await open({ plugins: [{ id: "spin", version: "1.0.0", source: "({ validators: [function () { for (;;) {} }] })" }], maxEvalMs: 300 });
    try {
      const context = looping.serialize({ formId: BASE_FORM_ID, values: CONTROL_VALUES["CTL-01"](), locale: "en", form: buildRoot({ definition: "base" }) });
      const run = await looping.run(context);
      expect(run.observation).toMatchObject({ kind: "refusal", refusal: "budget", code: "interrupted" });
      expect(run.elapsedMs).toBeGreaterThanOrEqual(250);
      expect(run.elapsedMs).toBeLessThan(5_000);
    } finally {
      looping.dispose();
    }
    await expect(open({ plugins: [{ id: "p", version: "1.0.0", source: "(42)" }] })).rejects.toMatchObject({ code: "not_a_module" });
    await expect(open({ plugins: [{ id: "p", version: "1.0.0", source: "({ validators: [ " }] })).rejects.toBeInstanceOf(StartupError);
  });

  it("never runs a module that no longer has the pinned hash: the guest hashes it again before it compiles", async () => {
    const forged: QjsWasiModule = { ...engine(), sha256: "0".repeat(64) };
    await expect(ProgramSession.open({ program: builtProgramText(), engine: forged })).rejects.toThrow(/did not start: qjs-wasi.wasm is not the pinned module/);
  });

  it("runs the vectors of the release gate and names the engine in the report", async () => {
    const report = await runSuite({ program: builtProgram(), engine: engine(), only: ["CTL-01", "ISO-02", "ISO-05", "RES-04"] });
    expect(report.environment.quickjs.package).toBe(`qjs-wasi.wasm (quickjs-ng) sha256:${PIN.sha256}`);
    const status = Object.fromEntries(report.results.map((result) => [result.id, result.status]));
    expect(status).toEqual({ "CTL-01": "PASS", "ISO-02": "PASS", "ISO-05": "PASS", "RES-04": "SKIP" });
    expect(report.results.find((result) => result.id === "RES-04")?.notes).toMatch(/heap recycler belongs to the quickjs-emscripten host/);
  }, 180_000);

  it("takes the module from the command line only with its sha256, and refuses one that is not it", async () => {
    const io = () => {
      const err: string[] = [];
      return { io: { stdout: () => undefined, stderr: (text: string) => void err.push(text) }, err };
    };
    const dir = mkdtempSync(join(tmpdir(), "datum-qjs-wasi-cli-"));
    const program = join(dir, "program.js");
    writeFileSync(program, builtProgramText());
    const alone = io();
    expect(await runCli(["--program", program, "--qjs-wasm", WASM], alone.io)).toBe(2);
    expect(alone.err.join("")).toMatch(/--qjs-wasm and --qjs-sha256 go together/);
    const wrong = io();
    expect(await runCli(["--program", program, "--qjs-wasm", WASM, "--qjs-sha256", "0".repeat(64)], wrong.io)).toBe(2);
    expect(wrong.err.join("")).toMatch(/the pinned qjs-wasi.wasm is 0{64}/);
    const right = io();
    expect(await runCli(["--program", program, "--qjs-wasm", WASM, "--qjs-sha256", PIN.sha256, "--only", "CTL-01", "--quiet"], right.io)).toBe(0);
  }, 120_000);
});
