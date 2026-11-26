// main.mjs — the endpoint the page delivers to.
//   qjs.mjs beside it: the engine, one process per run — Node 22 or later, nothing to install for it.
//   npm install express
//   curl -LO https://github.com/quickjs-ng/quickjs/releases/download/v0.16.2/qjs-wasi.wasm
//   node main.mjs
//
// The submission is re-validated in the very program the browser's sandbox runs
// (datum-sandbox-program.js, written beside the bundles), in a QuickJS of this process's own —
// QuickJS-ng's WebAssembly build, run by node:wasi: the same kernel over the same schema, the
// same rules, so the same verdict — codes and fields, never text — and the same sanitized
// values. Nothing is re-implemented here; nothing the page did is trusted either.
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

const FORM = JSON.parse(readFileSync("forms/customer-intake.json", "utf8"));

// The journey the answers were given through, from this server's own copy of the form: the
// envelope names it (submission.journey.id) and nothing more. Handed to the sandbox, it has the
// kernel work the path out again from the values, as the browser did: an answer on a page the
// path skipped is judged hidden, and a form field one of the journey's own fields fills or works
// out counts as asked on that page. None named, or one the form does not have: null, and the
// answers are judged as the whole form, which asks for every required field.
const journeyOf = (submission) => FORM.journey?.journeys?.find((journey) => journey.id === submission.journey?.id) ?? null;

// The engine: qjs-wasi.wasm, QuickJS-ng's own WebAssembly build from its release page, on V8 with
// node:wasi (qjs.mjs) — nothing to install. Every request runs it in a process of its own, so requests
// need no lock and share nothing: V8 has no store to hang a limit on, as wasmtime has, so the
// operating system draws the line instead, and the flag and the timeout below are that process's.
const RUNNER = fileURLToPath(new URL("qjs.mjs", import.meta.url));

// What a run can reach: one directory holding the program, and nothing else — not this
// directory, not the disk. Node's WASI mounts a directory read-write and does not promise the
// sandbox wasmtime's does, so a run is started in a directory of its own with nothing else in it.
const APP = programs();

function programs() {
  const app = mkdtempSync(join(tmpdir(), "datum-"));
  copyFileSync("datum-sandbox-program.js", join(app, "datum-sandbox-program.js"));
  // Gone with the process: at its exit, and on the signals that would otherwise end it without one.
  process.on("exit", () => rmSync(app, { recursive: true, force: true }));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => process.exit());
  return app;
}

/** A run that ended without an outcome: a limit cut it off, or a program or rule module would not load. */
class SandboxError extends Error {}

function qjs(argv, request, seconds, memory) {
  // One run: a process started in the program's directory, which it mounts as /app, the request on
  // its stdin, the answer on its stdout — all the run can reach; the runner hands it nothing else.
  // The limits are the process's, at the browser's profile: the memory in bytes, as the pages V8
  // lets the module's memory grow to, and the budget in seconds, a timeout that ends the process —
  // this run's alone, so a run past it interrupts no other: there is no engine-wide clock here, as
  // there is under wasmtime (see main.py). The budget counts the process's own start and the
  // module's compilation, a fifth of a second: it is a bound on a runaway rule, not a latency to
  // meet. Runaway recursion ends the run too: QuickJS's own stack check throws, and V8 traps the
  // instance's stack if it does not.
  return new Promise((resolve, reject) => {
    const flags = ["--wasm-max-mem-pages=" + memory / 65536, "--disable-warning=ExperimentalWarning"];
    const run = spawn(process.execPath, [...flags, RUNNER, ...argv], { cwd: APP, timeout: seconds * 1000 });
    const out = [];
    const err = [];
    run.stdout.on("data", (chunk) => out.push(chunk));
    run.stderr.on("data", (chunk) => err.push(chunk));
    run.stdin.on("error", () => {});  // a run that ended before reading its request: what ended it is on stderr
    run.stdin.end(request);
    run.on("error", reject);
    run.on("close", (code, signal) => {
      if (signal !== null) {  // the budget: the timeout ended the process
        reject(new SandboxError("interrupt"));
      } else if (code !== 0) {  // a throw: qjs printed it to stderr and exited 1
        reject(new SandboxError(Buffer.concat(err).toString().trim()));
      } else {
        resolve(Buffer.concat(out).toString().trimEnd());
      }
    });
  });
}

// What one run evaluates: the program, the page's rules registered into it, then the call — the
// context from stdin, the outcome to stdout. The program itself disables Date and Math.random.
const RULES = readFileSync("rules/intake-rules.js", "utf8");
const VALIDATE = ["-I", "/app/datum-sandbox-program.js", "-e", "__datum_register(" + RULES + "); print(__datum_run(std.in.readAsString()));"];

// What the rules read beside the values. The page injected a copy of its own; the server has the say.
const PHONE_COUNTRIES = ["CA", "US"];

// What the Country select shows, resolved here: the program never fetches a data source. An answer to a
// choice whose source is missing from the optionSnapshot below is refused (option.sourceUnavailable).
const COUNTRIES = [{ value: "CA", label: "Canada" }, { value: "US", label: "United States" }, { value: "MX", label: "Mexico" }];

// The run log comes back with the outcome — the sandbox has no console — and goes to this
// process's console, each entry at its own level: what the kernel did, step by step, and what
// the rules said, at LOG_LEVEL.
const LOG_LEVEL = "debug";  // "off", "error", "warn" (the kernel's default), "info" or "debug"

const app = express();
app.use(express.json());

app.post("/api/submissions", async (req, res) => {
  const { submissionKey } = req.body;  // the delivery is { document, submissionKey }: one key per attempt, the same key again is the same submission
  if (typeof submissionKey !== "string" || !submissionKey) {  // without one a retry could not be told from a new submission
    return res.status(400).json({ errors: [{ code: "bad_document" }] });
  }
  const { document: { submission } } = req.body;
  const context = {
    formId: FORM.id,
    form: FORM.root,  // the schema: field constraints and sanitization come from it
    values: submission.values,
    locale: submission.locale ?? "en",
    externalData: { phoneCountries: PHONE_COUNTRIES },
    optionSnapshot: { countries: COUNTRIES },  // the lists a choice's data source holds, by source id
    journey: journeyOf(submission),  // the path, worked out again from the values (see journeyOf)
    logLevel: LOG_LEVEL
  };
  let outcome;
  try {
    outcome = JSON.parse(await qjs(VALIDATE, JSON.stringify(context), 5, 32 * 1024 * 1024));
  } catch (failure) {  // a limit cut the run off, or a program or rule module would not load: fail closed, as the browser does
    if (!(failure instanceof SandboxError)) throw failure;  // anything else is this server's own: a 500
    console.error("sandbox failed for " + FORM.id, failure);
    return res.status(503).json({ errors: [{ code: "wasm.execution_error" }] });
  }
  for (const entry of outcome.logs ?? []) {
    console[entry.level](entry.message, entry.data ?? "");
  }
  if (outcome.errors.length > 0) {
    // 422 with the error contract, as the browser would have seen it; the page's messages word it.
    const errors = outcome.errors.map((e) => ({ field: e.componentId ?? null, code: e.code }));
    return res.status(422).json({ errors });
  }
  store(submissionKey, outcome.values);  // the sanitized values: what the form defines, nothing else
  res.json({ ok: true });
});

app.listen(8000);

function store(key, values) {
  // wherever submissions go: one record per key: the same key with the same values is that record again; the same key with other values is refused (409 submission.keyConflict)
}
