// main.mjs — the endpoint the page delivers to: the submission validated, then rendered as a PDF.
//   qjs.mjs beside it: the engine, one process per run — Node 22 or later, nothing to install for it.
//   npm install express
//   curl -LO https://github.com/quickjs-ng/quickjs/releases/download/v0.16.2/qjs-wasi.wasm
//   node main.mjs
//
// Two programs from beside the bundles, each run in a QuickJS of this process's own — QuickJS-ng's
// WebAssembly build, under node:wasi. datum-sandbox-program.js re-validates the envelope (see
// Validate on the server), and datum-pdf-program.js is the PDF kernel behind the browser's PDF
// button: the form's PDF layout laid out over the answers, the fonts embedded, the bytes written.
// The same program on any host, so the server's PDF is the browser's, byte for byte.
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

// Validation first, so the PDF prints the sanitized values: what the form defines, nothing else.
// Rules of the page's own register into this program too (see Validate on the server).
const VALIDATE = ["-I", "/app/datum-sandbox-program.js", "-e", "print(__datum_run(std.in.readAsString()));"];

// The PDF program, under the document profile: a PDF takes seconds and real memory. __datum_pdf
// answers with a promise; qjs runs the pending jobs once the script has run (the program's only
// timers are microtasks), so the answer is printed before it exits.
const RENDER = ["-I", "/app/datum-pdf-program.js", "-e", "__datum_pdf(std.in.readAsString()).then((json) => print(json));"];

// The fonts to embed, read from beside the bundles: the program has no file system. DejaVu Sans
// covers Latin, Greek, Cyrillic, Arabic and Hebrew; with no fonts, the standard 14 stand in.
function font(id, family, weight, file) {
  return { id, family, weight, style: "normal", data: readFileSync(join("fonts", file)).toString("base64") };
}

const FONTS = [font("dejavu-sans", "sans-serif", 400, "DejaVuSans.ttf"), font("dejavu-sans-bold", "sans-serif", 700, "DejaVuSans-Bold.ttf")];

// What the Country select shows, resolved here: the program never fetches a data source.
const COUNTRIES = [{ value: "CA", label: "Canada" }, { value: "US", label: "United States" }, { value: "MX", label: "Mexico" }];

const LOCALE = null;  // null renders in the submission's language; "en" or "fr-CA" picks one
const COMPACT = false;  // object streams and a compressed cross-reference: smaller, slower to write

// Which of the form's PDF layouts prints. A form designed in the builder's PDF mode may
// carry several under FORM.pdf.layouts — an applicant copy, an internal summary, a government
// template to fill — each with an id. Name one here, e.g. "applicant-copy", and the request asks
// for it by id ("layoutId" below), whatever the answers. null leaves the choice to the form: the
// first layout, in its list's order, whose "when" holds on these validated values — the layout the
// person's own download printed — else FORM.pdf.defaultLayoutId, the one marked default in the
// builder, else the first layout declared; a form with no layouts at all gets one derived from its
// tree, as this sample does. The response names the layout that printed (layoutId). An
// id the form lacks derives one too, with a "layout.notFound" warning in the response. A template
// layout whose PDF this server keeps needs its bytes in the request, and the answers may choose
// another template than the default: ask the "build" op first and send its layoutId back with
// that layout's bytes (a server running @argusvane/datum-engine can ask selectPdfLayoutForValues(FORM,
// outcome.values) instead). One submission, several PDFs: render once per id. A request may
// instead carry a whole layout object under "layout" — one kept outside the form — which then
// prints whatever the form declares, and whatever the answers.
const LAYOUT_ID = null;

const app = express();
app.use(express.json());

app.post("/api/submissions/pdf", async (req, res) => {
  const { submission } = req.body;
  const locale = submission.locale ?? "en";
  // The journey, if the answers came through one: the path is worked out again from the values (see journeyOf).
  const context = { formId: FORM.id, form: FORM.root, values: submission.values, locale, journey: journeyOf(submission), optionSnapshot: { countries: COUNTRIES } };
  const outcome = JSON.parse(await qjs(VALIDATE, JSON.stringify(context), 5, 32 * 1024 * 1024));
  if (outcome.errors.length > 0) {  // 422 with codes and fields, never text; the page's messages word them
    const errors = outcome.errors.map((e) => ({ field: e.componentId ?? null, code: e.code }));
    return res.status(422).json({ errors });
  }
  const request = {
    abi: "1.0.0",
    op: "document",
    form: FORM.root,
    pdf: FORM.pdf,  // the form's PDF layouts, as designed in the builder's PDF mode
    values: outcome.values,
    locale: LOCALE ?? locale,
    optionSnapshot: { country: COUNTRIES },
    fonts: FONTS,
    options: { compact: COMPACT },
    // The only time and identity the program ever sees: the same request gives the same bytes.
    env: { createdAt: new Date().toISOString(), documentId: randomUUID() }
  };
  if (LAYOUT_ID) {  // a specific layout by id, whatever the answers; left out, the answers choose (see LAYOUT_ID)
    request.layoutId = LAYOUT_ID;
  }
  const response = await render(request);
  if (!response.ok) {  // {"code": "font" | "layout" | "template" | "internal", "message": ...}
    return res.status(500).json({ error: response.error });
  }
  res.set({ "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="customer-intake.pdf"', "X-Page-Count": String(response.pageCount) });
  res.send(Buffer.from(response.bytes, "base64"));
});

app.listen(8000);

async function render(request) {
  return JSON.parse(await qjs(RENDER, JSON.stringify(request), 15, 256 * 1024 * 1024));
}
