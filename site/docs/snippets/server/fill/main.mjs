// main.mjs — the endpoint the page delivers to: the submission validated, then written into an existing PDF form.
//   qjs.mjs beside it: the engine, one process per run — Node 22 or later, nothing to install for it.
//   npm install express
//   curl -LO https://github.com/quickjs-ng/quickjs/releases/download/v0.16.2/qjs-wasi.wasm
//   node main.mjs
//
// The PDF is one this server already has (templates/customer-intake.pdf): an AcroForm whose fields the
// form's template layout maps to the answers. datum-sandbox-program.js re-validates the envelope
// (see Validate on the server) and datum-pdf-program.js fills the PDF — the kernel behind the
// browser's PDF button, in a QuickJS of this process's own: QuickJS-ng's WebAssembly build, under
// node:wasi. Nothing about PDFs is written here.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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

// What a run can reach: one directory holding the two programs, and nothing else — not this
// directory, not the disk. Node's WASI mounts a directory read-write and does not promise the
// sandbox wasmtime's does, so a run is started in a directory of its own with nothing else in it.
const APP = programs();

function programs() {
  const app = mkdtempSync(join(tmpdir(), "datum-"));
  for (const name of ["datum-sandbox-program.js", "datum-pdf-program.js"]) {
    copyFileSync(name, join(app, name));
  }
  // Gone with the process: at its exit, and on the signals that would otherwise end it without one.
  process.on("exit", () => rmSync(app, { recursive: true, force: true }));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => process.exit());
  return app;
}

/** A run that ended without an outcome: a limit cut it off, or a program or rule module would not load. */
class SandboxError extends Error {}

function qjs(argv, request, seconds, memory) {
  // One run: a process started in the programs' directory, which it mounts as /app, the request on
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

// The template layout, as the builder's PDF mode authored it: the PDF's fields and
// what fills each — a component's answer, an option's label through template text, a literal.
const LAYOUT = FORM.pdf.layouts.find((layout) => layout.id === "intake-template");

// The PDF itself, from this server's disk. The layout's template source names it (a storage this
// server resolves, not bytes in the definition), and the bytes ride with each request, base64.
const TEMPLATE = readFileSync("templates/customer-intake.pdf").toString("base64");

// Validation first, so the PDF is filled with the sanitized values: what the form defines, nothing else.
const VALIDATE = ["-I", "/app/datum-sandbox-program.js", "-e", "print(__datum_run(std.in.readAsString()));"];

// The PDF program, under the document profile; __datum_pdf's promise settles before qjs exits.
const RENDER = ["-I", "/app/datum-pdf-program.js", "-e", "__datum_pdf(std.in.readAsString()).then((json) => print(json));"];

// The fonts the kernel draws the filled fields with when the standard 14 cannot show an answer.
function font(id, family, weight, file) {
  return { id, family, weight, style: "normal", data: readFileSync(join("fonts", file)).toString("base64") };
}

const FONTS = [font("dejavu-sans", "sans-serif", 400, "DejaVuSans.ttf"), font("dejavu-sans-bold", "sans-serif", 700, "DejaVuSans-Bold.ttf")];

// What the Country select shows, resolved here: the layout's "{{country}}" writes the option's label.
const COUNTRIES = [{ value: "CA", label: "Canada" }, { value: "US", label: "United States" }, { value: "MX", label: "Mexico" }];

// What becomes of the filled fields. "editable" leaves them fields a reader may still change;
// "readonly" locks each one the fill touched; "flatten" burns the values into the page and drops
// the fields — an archive copy. The layout's own options are set here, per server.
const FIELDS = "editable";

const app = express();
app.use(express.json());

app.post("/api/submissions/fill", async (req, res) => {
  const { submission } = req.body;
  const locale = submission.locale ?? "en";
  // The journey, if the answers came through one: the path is worked out again from the values (see journeyOf).
  const context = { formId: FORM.id, form: FORM.root, values: submission.values, locale, journey: journeyOf(submission), optionSnapshot: { countries: COUNTRIES } };
  const outcome = JSON.parse(await qjs(VALIDATE, JSON.stringify(context), 5, 32 * 1024 * 1024));
  if (outcome.errors.length > 0) {  // 422 with codes and fields, never text; the page's messages word them
    const errors = outcome.errors.map((e) => ({ field: e.componentId ?? null, code: e.code }));
    return res.status(422).json({ errors });
  }
  const response = await render({
    abi: "1.0.0",
    op: "document",
    form: FORM.root,
    // The template layout, inline, with this server's fill options: this server's choice, so no
    // layout's "when" is tried, and the bytes below are that layout's.
    layout: { ...LAYOUT, options: { flatten: FIELDS === "flatten", readOnly: FIELDS === "readonly", appearances: "regenerate" } },
    // The PDF to fill: the bytes the layout's source names, resolved by this server.
    template: { data: TEMPLATE },
    values: outcome.values,
    locale,  // the language template texts resolve in: the country's name, here
    optionSnapshot: { country: COUNTRIES },
    fonts: FONTS,
    // The only time and identity the program ever sees: the same request gives the same bytes.
    env: { createdAt: new Date().toISOString(), documentId: randomUUID() }
  });
  if (!response.ok) {  // {"code": "template" | "font" | "internal", "message": ...}
    return res.status(500).json({ error: response.error });
  }
  // The fill report, one entry per mapped field: filled; cleared (no answer, or one a rule hid);
  // missing (the PDF has no field of that name); unsupported (a kind the kernel cannot fill).
  for (const field of response.fields) {
    console.info(`${field.status} ${field.pdfField} (${field.kind ?? "-"})`);
  }
  res.set({ "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="customer-intake-filled.pdf"', "X-Page-Count": String(response.pageCount) });
  res.send(Buffer.from(response.bytes, "base64"));
});

app.listen(8000);

async function render(request) {
  return JSON.parse(await qjs(RENDER, JSON.stringify(request), 15, 256 * 1024 * 1024));
}
