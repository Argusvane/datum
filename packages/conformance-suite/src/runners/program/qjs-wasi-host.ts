import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FREEZE_INTRINSICS_SNIPPET, QuickJsExecutionError, VALIDATION_PROFILE, assertRequestWithinLimits } from "@argusvane/datum-quickjs-wasm-host";

import { APP_PROGRAM, APP_RUN_SCRIPT, framed, guestArgv, hasStrayOutput, marker, newNonce, runScript, type QjsWasiEntry, type QjsWasiModule, type RuleModuleSource } from "./qjs-wasi.js";

/** What a run may write before it is ended as capped: the server hosts' caps (32 MiB of stdout, 64 KiB of stderr). */
export const STDOUT_CAP = 32 * 1024 * 1024;
export const STDERR_CAP = 64 * 1024;
/** The longest outcome a validation may answer, in UTF-16 code units, as on every host. */
export const MAX_OUTCOME_UNITS = 8 * 1024 * 1024;
/** How long a guest may take to start (Node, the module's compile, the program and the freeze) before it is stopped. */
export const DEFAULT_STARTUP_MS = 20_000;
/**
 * The evaluation budget of a call when the vector names none: the server hosts' default for a validation or an inspect
 * (`datum.runtime.validation.time_limit`, 5 s). It runs from the started marker, so the process start, the compile and
 * the program's load are not counted, as the Node host's budget does not count building its sandbox.
 */
export const QJS_WASI_BUDGET_MS = 5_000;
const WASM_PAGE = 64 * 1024;
const MIB = 1024 * 1024;
/** What the module's linear memory holds beside the JavaScript heap: the program's code, the C stack, and the copies of the request on stdin. */
export const LINEAR_MEMORY_HEADROOM_BYTES = 32 * MIB;

/**
 * The linear memory cap of a guest whose vector allows `heapBytes` of JavaScript heap. A vector's memory limit is the
 * QuickJS heap of the Node host (`memoryLimitBytes`, 32 MiB by default); the cap here is the module's whole linear
 * memory, as a server's `validation.memory` is, so it is the heap and {@link LINEAR_MEMORY_HEADROOM_BYTES} (64 MiB by default).
 */
export function linearMemoryBytes(heapBytes: number = VALIDATION_PROFILE.memoryLimitBytes): number {
  return heapBytes + LINEAR_MEMORY_HEADROOM_BYTES;
}

/**
 * The guest process: node:wasi running the module, as `site/docs/snippets/server/shared/qjs.mjs` runs it. It hashes the
 * file again before it compiles it, so a file changed after the host checked it is never run. The memory cap is the
 * process's `--wasm-max-mem-pages`, which bounds the module's linear memory as a wasmtime store limit does.
 */
const GUEST = [
  'import { createHash } from "node:crypto";',
  'import { readFileSync } from "node:fs";',
  'import { WASI } from "node:wasi";',
  "const [wasmPath, sha256, appDir, ...args] = process.argv.slice(1);",
  "const wasm = readFileSync(wasmPath);",
  'if (createHash("sha256").update(wasm).digest("hex") !== sha256) { process.stderr.write("qjs-wasi.wasm is not the pinned module\\n"); process.exit(70); }',
  'const wasi = new WASI({ version: "preview1", args, env: {}, preopens: { "/app": appDir }, returnOnExit: true });',
  "const instance = await WebAssembly.instantiate(await WebAssembly.compile(wasm), wasi.getImportObject());",
  "process.exitCode = wasi.start(instance);"
].join("\n");

export interface QjsWasiHostOptions {
  module: QjsWasiModule;
  /** The sandbox program's text. */
  program: string;
  /** The rule modules every call registers, in order. */
  plugins?: readonly RuleModuleSource[];
  /** The evaluation budget of every call; left out, {@link QJS_WASI_BUDGET_MS}. */
  maxEvalMs?: number;
  /** The JavaScript heap a vector allows (default 32 MiB, as on the Node host); the linear memory cap is {@link linearMemoryBytes} of it. */
  memoryLimitBytes?: number;
  maxStartupMs?: number;
  /** False leaves the freeze snippet out of the run script: the negative control of the freeze (tests only). */
  freezeIntrinsics?: boolean;
}

interface GuestOutcome {
  end: "exit" | "budget" | "startup" | "cap";
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  started: boolean;
  /** From the started marker to the end of the run: the evaluation, without the process start and the program load. */
  evalMs: number;
}

/** Programs and module lists that started once; starting is deterministic, so each is proven once per process. */
const proven = new Set<string>();

/**
 * The sandbox program on `qjs-wasi.wasm`, one guest run per call: what the FastAPI and Spring Boot hosts do with the
 * same module under wasmtime and Endive. Every call gets its own process, its own instance of the module and its own
 * `/app` directory holding only the program and the run script, so nothing one call did reaches the next. node:wasi
 * does not mount `/app` read-only as the servers do; a fresh directory per call keeps a write from outliving its run.
 *
 * The answer is judged as the servers judge it: a run stopped by its budget, by its output cap or by a nonzero exit is
 * never an answer, whatever its stdout holds, and a clean exit answers only with exactly one frame of its nonce. The
 * failures are the Node host's typed errors ({@link QuickJsExecutionError}), so the program runner reads both alike.
 */
export class QjsWasiHost {
  /** The evaluation time of the last call (from the started marker), which the program runner reports. */
  public lastEvalMs: number | undefined;

  private readonly plugins: readonly RuleModuleSource[];
  private readonly freeze: string | undefined;
  private readonly memoryPages: number;
  private readonly maxStartupMs: number;
  private disposed = false;

  private constructor(private readonly options: QjsWasiHostOptions) {
    this.plugins = options.plugins ?? [];
    this.freeze = options.freezeIntrinsics === false ? undefined : FREEZE_INTRINSICS_SNIPPET;
    this.memoryPages = Math.floor(linearMemoryBytes(options.memoryLimitBytes) / WASM_PAGE);
    this.maxStartupMs = options.maxStartupMs ?? DEFAULT_STARTUP_MS;
  }

  /**
   * Proves the program loads and every rule module registers, as the Node host does when it builds a sandbox: a
   * startup run evaluates the program, removes the globals, freezes, registers the modules and calls no entry point.
   * A module that is not one fails here (`not_a_module`, or `compile_error` for a syntax error).
   */
  public static async create(options: QjsWasiHostOptions): Promise<QjsWasiHost> {
    const host = new QjsWasiHost(options);
    const key = createHash("sha256").update(JSON.stringify([options.module.sha256, options.program, host.freeze ?? null, host.plugins, host.memoryPages])).digest("hex");
    if (!proven.has(key)) {
      const nonce = newNonce();
      const outcome = await host.guest(runScript(host.freeze, host.plugins, "startup"), `${nonce}\n`, host.maxStartupMs);
      if (outcome.end !== "exit" || outcome.exitCode !== 0 || framed(outcome.stdout, nonce) === undefined) {
        const detail = stderrText(outcome.stderr);
        const syntax = /^SyntaxError\b/.test(detail);
        if (!outcome.started) {
          throw new QuickJsExecutionError(syntax ? "compile_error" : "runtime_error", `The sandbox program did not start: ${detail || describeEnd(outcome, host.maxStartupMs)}`);
        }
        throw new QuickJsExecutionError(syntax ? "compile_error" : "not_a_module", `A rule module did not register: ${detail || describeEnd(outcome, host.maxStartupMs)}`);
      }
      proven.add(key);
    }
    return host;
  }

  /** One `__datum_run` over serialized context text. */
  public run(serializedContext: string): Promise<string> {
    return this.call("run", serializedContext);
  }

  /** One `__datum_inspect` over request text. */
  public inspect(serializedRequest: string): Promise<string> {
    return this.call("inspect", serializedRequest);
  }

  public dispose(): void {
    this.disposed = true;
  }

  private async call(entry: QjsWasiEntry, argument: string): Promise<string> {
    this.lastEvalMs = undefined;
    if (this.disposed) {
      throw new QuickJsExecutionError("runtime_error", "The sandbox host was disposed");
    }
    // Refused before a guest is started for it, as every host does.
    assertRequestWithinLimits(argument, VALIDATION_PROFILE);
    const budget = this.options.maxEvalMs ?? QJS_WASI_BUDGET_MS;
    const nonce = newNonce();
    const outcome = await this.guest(runScript(this.freeze, this.plugins, entry), `${nonce}\n${argument}`, budget);
    this.lastEvalMs = outcome.evalMs;
    const detail = stderrText(outcome.stderr);
    if (outcome.end === "cap") {
      throw new QuickJsExecutionError("outcome_too_large", `The sandbox run wrote more than its output limit (${STDOUT_CAP} bytes to stdout, ${STDERR_CAP} to stderr)`);
    }
    if (outcome.end === "budget") {
      throw new QuickJsExecutionError("interrupted", `The sandbox run passed its ${budget} ms budget`);
    }
    if (outcome.end === "startup") {
      throw new QuickJsExecutionError("interrupted", `The sandbox did not start within ${this.maxStartupMs} ms`);
    }
    if (outcome.exitCode === 0) {
      const answer = framed(outcome.stdout, nonce);
      if (answer === undefined) {
        throw new QuickJsExecutionError("runtime_error", hasStrayOutput(outcome.stdout, nonce) ? "The sandbox wrote outside its answer frame" : "The sandbox printed no outcome");
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(answer);
      } catch {
        throw new QuickJsExecutionError("runtime_error", "The sandbox printed something that is not UTF-8");
      }
      if (entry === "run" && text.length > MAX_OUTCOME_UNITS) {
        throw new QuickJsExecutionError("outcome_too_large", `The outcome is ${text.length} characters long; a run may answer at most ${MAX_OUTCOME_UNITS}`);
      }
      return text;
    }
    if (!outcome.started) {
      throw new QuickJsExecutionError("runtime_error", `The sandbox exited before it started: ${detail}`);
    }
    // A nonzero exit after the started marker: the program threw. QuickJS's own out-of-memory report is the
    // module's memory cap reached (the stderr words are kept, so the refusal reads as a budget).
    throw new QuickJsExecutionError("runtime_error", detail === "" ? "The sandbox program threw" : detail);
  }

  /** One guest run: a fresh `/app` with the program and this script, stdin written whole, the budget from the started marker. */
  private guest(script: string, stdin: string, budgetMs: number): Promise<GuestOutcome> {
    const app = mkdtempSync(join(tmpdir(), "datum-qjs-wasi-"));
    writeFileSync(join(app, APP_PROGRAM), this.options.program);
    writeFileSync(join(app, APP_RUN_SCRIPT), script);
    const startedMark = Buffer.from(marker(stdin.slice(0, 32), "started"));
    return new Promise<GuestOutcome>((resolve) => {
      const child = spawn(
        process.execPath,
        [`--wasm-max-mem-pages=${this.memoryPages}`, "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", GUEST, "--", this.options.module.path, this.options.module.sha256, app, ...guestArgv()],
        { stdio: ["pipe", "pipe", "pipe"], env: {} }
      );
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let end: GuestOutcome["end"] = "exit";
      let started = false;
      let startedAt = 0;
      const stop = (why: GuestOutcome["end"]): void => {
        if (end === "exit") {
          end = why;
        }
        child.kill("SIGKILL");
      };
      let timer = setTimeout(() => stop("startup"), this.maxStartupMs);
      child.stdout.on("data", (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > STDOUT_CAP) {
          stop("cap");
          return;
        }
        out.push(chunk);
        if (!started && Buffer.concat(out).includes(startedMark)) {
          started = true;
          startedAt = performance.now();
          clearTimeout(timer);
          timer = setTimeout(() => stop("budget"), budgetMs);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        errBytes += chunk.length;
        if (errBytes > STDERR_CAP) {
          stop("cap");
          return;
        }
        err.push(chunk);
      });
      // A guest that ends before it reads all of stdin closes the pipe under the write; its exit says what happened.
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin);
      child.on("close", (code) => {
        clearTimeout(timer);
        rmSync(app, { recursive: true, force: true });
        resolve({ end, exitCode: code, stdout: Buffer.concat(out), stderr: Buffer.concat(err), started, evalMs: started ? performance.now() - startedAt : 0 });
      });
    });
  }
}

function stderrText(stderr: Buffer): string {
  return stderr.toString("utf8").trim();
}

function describeEnd(outcome: GuestOutcome, startupMs: number): string {
  if (outcome.end === "startup") {
    return `no start within ${startupMs} ms`;
  }
  if (outcome.end === "cap") {
    return "the output limit was passed";
  }
  return `exit ${outcome.exitCode ?? "by signal"}`;
}
