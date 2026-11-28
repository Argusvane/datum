// Guards what each bundle carries: the
// renderer module without any PDF layer, its pipeline in a lazy chunk beside it; the builder
// module with the designer but the executor and pdf.js each in a lazy chunk; the PDF module
// with the executor; pdf.js in the page imagery module and nowhere the renderer reaches; the
// sandbox in its own module and nowhere else; the two programs a server evaluates as plain
// scripts. A design-system binding, a component library or an icon set is a package of its own
// that builds and checks its own bundle; this package depends on none, so none can ride in
// these. Run after the builds, before the types.
//
// Guard plug-ins: every scripts/guards/*.mjs (sorted by name; none is fine) is
// imported and run after the checks below, so a feature adds its guards and budgets in a file of
// its own. A guard default-exports `function (ctx)` with ctx = { dist, files, read, chunksOf,
// expect, sizeKb, entryText, entryKb, sourcesOf, coreOf } (sizeKb(name) is a file's size in KB)
// and may export `budgets`, an object of file name -> KB. For each name the budget in force is the
// minimum of BUDGETS_KB's number and every guard's override; a guard raising a budget above the
// base is reported as a problem.
//
// The entry and its core chunk (Vite 8 / Rolldown): the build gathers the modules an
// entry and its lazy chunks share into ONE chunk per entry, datum-form-core-<hash>.js and
// datum-builder-core-<hash>.js, which the entry imports statically on load (vite.config.ts,
// scripts/build-bundles.mjs), where Rollup kept them inside the entry file. The initial payload of
// a bundle is therefore the pair, so: `entryText("datum-form.js")` is the entry's text plus its
// core chunk's (every "the entry carries X" check reads it), `entryKb("datum-form.js")` is the
// pair's size (the pair's gzip is what the gzip gates below hold), `sourcesOf(name)` is a file's source
// map's module paths (an entry's: the pair's), and `chunksOf` never lists a core chunk as a lazy
// one. `read("datum-form.js")` is still the entry file alone.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { CORE_CHUNK, bundleReaders, effectiveBudgets, loadGuards, runGuards } from "./guards/lib/loader.mjs";

const dist = join(fileURLToPath(new URL(".", import.meta.url)), "..", "dist");
const files = readdirSync(dist).filter((name) => name.endsWith(".js") && !name.includes("vite-browser-external"));
const read = (name) => readFileSync(join(dist, name), "utf8");
/** The programs written beside the bundles for a server's own QuickJS: plain scripts, never modules or chunks. */
const PROGRAMS = ["datum-sandbox-program.js", "datum-pdf-program.js"];
const isPlainScript = (text) => !/^\s*(import|export)\s/m.test(text);

// One distinctive string per layer.
const PIPELINE = "mapping.unresolved"; // render/pdf/pdf-template.ts — the PDF render pipeline
const DESIGNER = "datum-pdf-schematic"; // the PDF designer's template-mode dialog (its page viewer's classes; the shell's stylesheet names them too, so the renderer check below is the one it serves)
const PDF_DESIGNER_CHUNK = "data-add-custom"; // the PDF designer's Add popover (pdf-designer-panels.ts): spelled by the designer's lazy chunk alone, never by the module
const KERNEL = "PDFAcroForm"; // pdf-lib, inside the executor
const SANDBOX = "__datum_register"; // the QuickJS sandbox program (quickjs-wasm-host)
const CODE_EDITOR = "cm-lineNumbers"; // CodeMirror, the builder's JSON boxes (json-viewer.ts), a lazy chunk
const FORMULA_EDITOR = "f-field ref-chip unknown"; // the formula editor's unknown-field mark classes as its JS spells them (builder/formula/formula-editor.ts; the shared .ref-chip look between them): a lazy chunk beside CodeMirror's, never eager. The hosts' sheets (FORMULA_EDITOR_STYLES, eager by design) spell it ".f-field.unknown", so the string with the spaces is the editor's alone
const FORMULA_DOCS = "The first argument that is not null or missing."; // the function table's words (core function-docs.ts): the builder's, never the runtime's
const PDFJS = "GlobalWorkerOptions"; // pdf.js, inside the page imagery module
const SIGNER = "Adobe.PPKLite"; // the signature dictionary the kernel writes: the signature pass, inside the executor
const JOURNEY_DIAGNOSTICS = "condition.reads-later-page"; // diagnoseJourneys: a lazy chunk `debug` loads, never in a bundle
const JOURNEY_DESIGNER = "data-journey-add-stakes"; // the Journeys designer's add popover (journey-designer-panels.ts): a lazy chunk the builder's Journeys mode loads
const JOURNEY_STEP_VIEW = "journey.step.takeOffBar"; // the Step view's inspector words (step-view.ts): it lives in the designer's chunk, never in the module or its core
const JOURNEY_MAP = "datum-journey-map"; // the journey flow map's root class: a lazy chunk the designer loads on the first Map
const JOURNEY_PREVIEW = "data-journey-try-session"; // the Journey card's marker: the journey Try it runs, a lazy chunk the designer loads ahead of Try it
const JOURNEY_AUTHORING = "journey.designer.own.fillsField"; // "Fills form field" (journey-authoring-texts-en.ts): the page-only fields' chunk the designer loads before it builds a journey
const LOGIC_SURFACE = "flow-step--conditional"; // the Logic surface's page-flow strip: a lazy chunk the builder loads on first opening Logic
const DATA_SURFACE = "data-data-row"; // the Data surface's table rows: a lazy chunk the builder loads on first opening Data
const LANGUAGES_SURFACE = "data-languages-cell"; // the Languages surface's text cells: a lazy chunk the builder loads on first opening Languages
const OVERVIEW_SURFACE = "data-overview-open"; // the Journeys and PDF overviews' Open: a lazy chunk the builder loads on first opening either
// Try it's panel: a lazy chunk the builder loads on the first Try it. Its WebAssembly
// part's attribute, spelled only in try-it.ts: `try-card` is the journey try session's too (its
// Journey card wears the panel's card look).
const TRY_IT = "data-try-wasm";
const COMMAND_PALETTE = "data-palette-input"; // the command palette's box: a lazy chunk the builder loads on its first opening
const ENTRY_NAMES = ["datum-form", "datum-builder", "datum-pdf", "datum-pdf-pages", "datum-wasm"];

// A default build removes every source map once this check has run inside it
// (scripts/strip-source-maps.mjs), and the checks below read them. On such a folder there is
// nothing to judge: say so once, instead of one problem per missing map and the false alarms
// that follow from reading no sources.
if (files.length > 0 && !readdirSync(dist).some((name) => name.endsWith(".js.map"))) {
  console.error("check-bundles: dist has no source maps, so the checks cannot run on it. A default build runs them before it removes the maps; to run check-bundles on its own, build with DATUM_SOURCE_MAPS=1.");
  process.exit(1);
}

const problems = [];
const expect = (condition, message) => {
  if (!condition) {
    problems.push(message);
  }
};
// A bundle's lazy chunks: `<base>-<name>-<hash>.js`, never another entry (`datum-pdf-pages.js` is not a `datum-pdf` chunk), a program,
// nor the entry's own core chunk (the shared-module chunk the entry imports statically on load: part of its initial payload, read with the entry).
const chunksOf = (base) => files.filter((name) => name.startsWith(`${base}-`) && !ENTRY_NAMES.some((entry) => entry !== base && name.startsWith(`${entry}.`)) && !PROGRAMS.includes(name) && !CORE_CHUNK.test(name));
const { coreOf, entryText, entryKb, sourcesOf } = bundleReaders({ dist, files, read, expect });

// The entries' initial payload: the entry and its core chunk (see the header).
const form = entryText("datum-form.js");
expect(!form.includes(PIPELINE), "datum-form.js (with its core chunk) carries the PDF pipeline; it must stay in a lazy chunk");
expect(!form.includes(DESIGNER), "datum-form.js (with its core chunk) carries the PDF designer");
expect(!form.includes(KERNEL), "datum-form.js (with its core chunk) carries the PDF executor");
expect(!form.includes(CODE_EDITOR), "datum-form.js (with its core chunk) carries the builder's JSON editor (CodeMirror); the renderer never shows JSON");
expect(chunksOf("datum-form").filter((name) => read(name).includes(PIPELINE)).length === 1, "exactly one datum-form-*.js chunk should carry the PDF pipeline");
expect(!form.includes(PDFJS), "datum-form.js (with its core chunk) carries pdf.js; only the builder draws pages");
// The formulas ride with the runtime: the parser and the compile step are allowed in
// datum-form.js, since a definition is compiled where it is loaded. The authoring side is not:
// the formula editor (a lazy chunk of the builder's) and the function table's summaries and
// examples (the builder's and the docs') stay out of the renderer.
expect(!form.includes(FORMULA_EDITOR), "datum-form.js (with its core chunk) carries the formula editor; it belongs in the builder's lazy chunk");
expect(!form.includes(FORMULA_DOCS), "datum-form.js (with its core chunk) carries the function table's summaries (function-docs.ts); the runtime needs names and arity alone");
for (const name of chunksOf("datum-form")) {
  expect(!read(name).includes(FORMULA_EDITOR), `${name} carries the formula editor; the renderer never edits a formula`);
}
expect(!form.includes(DATA_SURFACE), "datum-form.js (with its core chunk) carries the builder's Data surface; the renderer never builds a form from a model");
for (const name of chunksOf("datum-form")) {
  expect(!read(name).includes(PDFJS), `${name} carries pdf.js; the renderer never draws pages`);
}
// The journey diagnostics are an author's check: `debug` loads them from a chunk of
// their own, so a form being filled never downloads them.
expect(!form.includes(JOURNEY_DIAGNOSTICS), "datum-form.js (with its core chunk) carries the journey diagnostics; they belong in a lazy chunk `debug` loads (src/journey-diagnostics.ts)");
expect(chunksOf("datum-form").filter((name) => read(name).includes(JOURNEY_DIAGNOSTICS)).length === 1, "exactly one datum-form-*.js chunk should carry the journey diagnostics");
// The Journeys designer is the builder's: the renderer neither carries it nor emits
// a chunk of it, though the engine's root it imports re-exports the mode that loads it.
expect(!form.includes(JOURNEY_DESIGNER), "datum-form.js (with its core chunk) carries the Journeys designer; it is a lazy chunk of the builder's");
expect(!form.includes(JOURNEY_STEP_VIEW), "datum-form.js (with its core chunk) carries the Journeys Step view; it is a lazy chunk of the builder's");
for (const name of chunksOf("datum-form")) {
  expect(!read(name).includes(JOURNEY_DESIGNER), `${name} carries the Journeys designer; the renderer never designs a journey`);
  expect(!read(name).includes(JOURNEY_STEP_VIEW), `${name} carries the Journeys Step view; the renderer never designs a journey`);
}
// The journey flow map is the builder's too, a chunk of its own behind the designer's.
expect(!form.includes(JOURNEY_MAP), "datum-form.js (with its core chunk) carries the journey flow map; it is a lazy chunk of the builder's");
for (const name of chunksOf("datum-form")) {
  expect(!read(name).includes(JOURNEY_MAP), `${name} carries the journey flow map; the renderer never draws one`);
}
// So is the journey Try it runs, a chunk of its own behind the designer's.
expect(!form.includes(JOURNEY_PREVIEW), "datum-form.js (with its core chunk) carries the journey try session; it is a lazy chunk of the builder's");
expect(!form.includes(TRY_IT), "datum-form.js (with its core chunk) carries Try it's panel; it is a lazy chunk of the builder's");
for (const name of chunksOf("datum-form")) {
  expect(!read(name).includes(JOURNEY_PREVIEW), `${name} carries the journey try session; the renderer never tries a journey`);
}
// No binding bundle is built here at all: a design-system package builds its own.
for (const prefix of ["datum-binding"]) {
  expect(!files.some((name) => name.startsWith(prefix)), `dist/ holds a ${prefix}*.js: this package builds no binding bundle; a design-system binding is a package of its own (bindings/<id>)`);
}
// Size budgets: the renderer carries no theme and no component library and the
// builder no icon library, so these are budgets the next package cannot grow, each measured after its split and
// given slack. The two entries are held to the gzip gates below; the sandbox module and the lazy
// chunks have budgets of their own. The classic scripts are minified and are not held to these.
// The minify pass prints UTF-8 unescaped: with esbuild's ASCII default it escapes every non-ASCII
// character and takes datum-wasm.js from 761 to 885 KB.
const guards = await loadGuards(join(dist, "..", "scripts", "guards"));
const BASE_BUDGETS_KB = {
  // The two entries (datum-form.js, datum-builder.js) are held to the gzip gates below, not to a size here.
  // datum-wasm.js: measured 984.4 KB, plus 3 KB, rounded up. It carries the sandbox's security code
  // (the regex reader, the structural `check` pass, the output limits), the grid normalizer mirror,
  // the row-count check, the formula bounds, the form-test parser, judge and kernel driver for the
  // `test` op, the bind-time ABI probe, the per-request size term, the prepared-definition cache,
  // the host context read, the bounded journey walks and the freeze's guard on the global object.
  "datum-wasm.js": 988
};
const BUDGETS_KB = effectiveBudgets(BASE_BUDGETS_KB, guards, problems);
// The validation kernel is the sandbox's: <datum-form> never runs it in-process,
// so it stays out of the renderer (WasmValidationHost's in-process adapter is an
// explicit import for that reason).
expect(!form.includes("is not a usable journey"), "datum-form.js (with its core chunk) carries the validation kernel; WasmValidationHost's in-process adapter has been imported by the renderer");
for (const [name, budget] of Object.entries(BUDGETS_KB)) {
  const kb = statSync(join(dist, name)).size / 1024;
  expect(kb <= budget, `${name} is ${kb.toFixed(1)} KB, over its ${budget} KB budget; a component library, an icon library or another eager import has crept in`);
}
// Each entry's initial payload, the entry plus its core chunk, gzipped at level 9 file by file
// (Node's zlib, as here; a page fetches them as two files), is at most the recorded base pair plus
// 4 KB. The base pairs are what CI measures on its runner, whose build comes out slightly larger
// than a developer machine's. A gate is raised only deliberately, never to fit a measurement.
// Raised by what the renderer's checks add to the initial payload, as measured against the previous
// build on one machine: the token value scan, the stored-answer shapes, the file writes' guard and
// row keys, the stylesheet scanner, the submission lock's focus rules and the print answer rules
// (datum-form.js +3,417 B, datum-builder.js +4,256 B). Both were raised by 512 B more for the origin
// rule's own code in the elements: an attribute's URL resolved once and checked again before its
// module is imported, and the wasm-integrity attribute (its check is a lazy chunk). The builder's
// was raised by 768 B more for the fixes to its drafts, renames, mode switches, panels and Logic
// editor, which add about 760 B gzip to its eager code.
const GZIP_BASE = { "datum-form.js": 207_397, "datum-builder.js": 522_303 };
const GZIP_ALLOWANCE = 4 * 1024;
const pairGzip = (name) => [name, ...coreOf(name.replace(/\.js$/, ""))].reduce((total, part) => total + gzipSync(readFileSync(join(dist, part)), { level: 9 }).length, 0);
for (const [name, base] of Object.entries(GZIP_BASE)) {
  const gzip = pairGzip(name);
  const gate = base + GZIP_ALLOWANCE;
  expect(gzip <= gate, `${name} (with its core chunk) is ${gzip} B gzip, ${gzip - gate} B over its gate of ${gate} B (base ${base} B plus 4 KB); an eager import has crept in, or the gate needs a deliberate raise`);
}
// The renderer's lazy PDF pipeline has a budget of its own: the chunk a form's Preview PDF loads,
// which the engine's side-effect-free marking keeps to what it uses. It holds the theme and layout
// logic, the PDF render caps, the attachment-type sniff, the decoded-length size check and the
// structural sniffer, the component style checks, the value-path model index, the stored-answer
// fallback of the choice renditions and the attachment refusal by name. Measured 88.1 KB at the
// last raise; lazy chunks get measured + 2.
const FORM_PDF_CHUNK_BUDGET_KB = 91;
// The builder's Journeys designer chunk, the one the Journeys side loads when it is first opened:
// the designer, its Step view, the Check answers step, the findings wording and the preview
// surface's session, surface and styles; the runtime it builds comes from datum-builder.js. The
// journey diagnostics it shows are a chunk of their own it shares with `debug`. The page-only
// fields went to a chunk of their own and the preview to another, which keeps this one in budget.
const JOURNEY_DESIGNER_CHUNK_BUDGET_KB = 81; // measured 77,047 B (75.2 KB) plus 2 KB, rounded up
// The PDF designer's chunk, which the PDF mode loads the first time a layout is opened, Preview
// PDF or Add is used: the designers over a custom layout and a populated form, the PDF component
// table and its English, the page viewer, the Preview dialog, the Add popover, the template
// planners (pdf-designer-chunk.ts) and the value maps with their stale-entry checks. It is split
// out of datum-builder.js, which keeps the PDF mode as a thin shell: the table of PDF component
// English, the faces and the property tables sit in the chunk because the shell imports no module
// that holds them. Measured 115,797 B (113.1 KB), plus 2 KB, rounded up.
const PDF_DESIGNER_CHUNK_BUDGET_KB = 116;
// The journey try session's chunk, which the designer's chunk loads ahead of Try it: the session
// that keeps the runtime current, its Submit and checks, the Journey card's markup; the runtime it
// builds comes from datum-builder.js, the page names and the tree's placement from the designer's
// chunk, already on the page. The canvas draws the form it runs. Measured about 9.8 KB, budgeted at 12.
const JOURNEY_PREVIEW_CHUNK_BUDGET_KB = 12;
// The page-only fields' chunk, which the designer's chunk loads before it builds a journey's
// controller (whose types are fixed when it is built): the palette's page-only groups and the
// worked-out value, the form's definitions derived for a presentation, the own "Fills form field"
// and its choices, "Ask differently here...". Split out so the designer's chunk stays well within
// its budget. Measured about 15.5 KB, budgeted at 18.
const JOURNEY_AUTHORING_CHUNK_BUDGET_KB = 18;
// The journey flow map's chunk, which the designer's chunk loads the first time Map is chosen: its
// model, layered layout, SVG, styles and surface (editing in place: Add step, New rule, the
// selection bar), the layout the most of it; its graph facts come from the diagnostics chunk the
// designer shares with `debug`. Measured 83,243 B (81.3 KB), rounded up to 83.
const JOURNEY_MAP_CHUNK_BUDGET_KB = 83;
// Try it's chunk, which the canvas loads the first time the form is tried: the panel's markup and
// styles, the checks, the Submit and Preview PDF logic, a mode's session (its submit, checks and
// errors), the Recording control, Assert this's snapshot, Show me's givens, the agent-driven run
// seams and the chunk's own English table. Measured 39,872 B (38.9 KB), plus 3 KB, rounded up.
const TRY_IT_CHUNK_BUDGET_KB = 42;
for (const name of chunksOf("datum-form").filter((chunk) => read(chunk).includes(PIPELINE))) {
  expect(statSync(join(dist, name)).size <= FORM_PDF_CHUNK_BUDGET_KB * 1024, `${name} is over its ${FORM_PDF_CHUNK_BUDGET_KB} KB budget; the renderer's PDF pipeline chunk has taken in more than the pipeline`);
}

const builder = entryText("datum-builder.js");
// The PDF designer is a chunk the PDF mode loads on demand (pdf-designer-loader.ts):
// the builder is still the HTML and PDF builder, its module carrying the mode, the catalog and the
// conditions, and the classic script carrying the designer inline.
expect(!builder.includes(PDF_DESIGNER_CHUNK), "datum-builder.js (with its core chunk) carries the PDF designer's panels statically; they must stay in the lazy chunk the PDF mode loads");
const pdfDesignerChunks = chunksOf("datum-builder").filter((name) => read(name).includes(PDF_DESIGNER_CHUNK));
expect(pdfDesignerChunks.length === 1, "exactly one datum-builder-*.js chunk should carry the PDF designer");
for (const name of pdfDesignerChunks) {
  expect(statSync(join(dist, name)).size <= PDF_DESIGNER_CHUNK_BUDGET_KB * 1024, `${name} is over its ${PDF_DESIGNER_CHUNK_BUDGET_KB} KB budget; the PDF designer's chunk has taken in more than the designer`);
  expect(!read(name).includes(KERNEL) && !read(name).includes(PDFJS), `${name} carries the PDF executor or pdf.js; each is a chunk of its own`);
}
expect(read("datum-builder.iife.js").includes(PDF_DESIGNER_CHUNK), "datum-builder.iife.js should carry the PDF designer inline");
// The data-model import belongs to the Data workspace: it rides the Data surface's chunk.
{
  const surface = chunksOf("datum-builder").find((name) => read(name).includes(DATA_SURFACE));
  expect(surface !== undefined && read(surface).includes("data-data-close"), "the Data surface's chunk should carry the data surface markup");
}
expect(!builder.includes(COMMAND_PALETTE), "datum-builder.js (with its core chunk) carries the command palette statically; it must stay in the lazy chunk its first opening loads");
expect(chunksOf("datum-builder").filter((name) => read(name).includes(COMMAND_PALETTE)).length === 1, "exactly one datum-builder-*.js chunk should carry the command palette");
// Try it: the panel's cards, checks and the controller behind them, a chunk the canvas
// loads the first time the form is tried. The module names the panel only as [data-try-panel].
expect(!builder.includes(TRY_IT), "datum-builder.js (with its core chunk) carries Try it's panel statically; it must stay in the lazy chunk the first Try it loads");
const tryItChunks = chunksOf("datum-builder").filter((name) => read(name).includes(TRY_IT));
expect(tryItChunks.length === 1, "exactly one datum-builder-*.js chunk should carry Try it's panel");
for (const name of tryItChunks) {
  expect(statSync(join(dist, name)).size <= TRY_IT_CHUNK_BUDGET_KB * 1024, `${name} is over its ${TRY_IT_CHUNK_BUDGET_KB} KB budget; Try it's chunk has taken in more than the panel`);
}
expect(read("datum-builder.iife.js").includes(TRY_IT), "datum-builder.iife.js should carry Try it's panel inline");
for (const name of chunksOf("datum-form")) {
  expect(!read(name).includes(TRY_IT), `${name} carries Try it's panel; the renderer never tries a form`);
}
expect(!builder.includes(OVERVIEW_SURFACE), "datum-builder.js (with its core chunk) carries the Journeys and PDF overviews statically; they must stay in the lazy chunk those workspaces load");
expect(chunksOf("datum-builder").filter((name) => read(name).includes(OVERVIEW_SURFACE)).length === 1, "exactly one datum-builder-*.js chunk should carry the Journeys and PDF overviews");
expect(!builder.includes(DATA_SURFACE), "datum-builder.js (with its core chunk) carries the Data surface statically; it must stay in the lazy chunk Data loads");
expect(chunksOf("datum-builder").filter((name) => read(name).includes(DATA_SURFACE)).length === 1, "exactly one datum-builder-*.js chunk should carry the Data surface");
expect(!builder.includes(LANGUAGES_SURFACE), "datum-builder.js (with its core chunk) carries the Languages surface statically; it must stay in the lazy chunk Languages loads");
expect(chunksOf("datum-builder").filter((name) => read(name).includes(LANGUAGES_SURFACE)).length === 1, "exactly one datum-builder-*.js chunk should carry the Languages surface");
expect(!builder.includes(LOGIC_SURFACE), "datum-builder.js (with its core chunk) carries the Logic surface statically; it must stay in the lazy chunk Logic loads");
expect(chunksOf("datum-builder").filter((name) => read(name).includes(LOGIC_SURFACE)).length === 1, "exactly one datum-builder-*.js chunk should carry the Logic surface");
// The JSON boxes' editor (CodeMirror) is a chunk the panels load on first use (json-viewer-loader.ts).
expect(!builder.includes(CODE_EDITOR), "datum-builder.js (with its core chunk) carries the JSON editor (CodeMirror) statically; it must stay in the lazy chunk the JSON boxes load");
// Since the formula editor shares CodeMirror, the library sits in a shared chunk the
// two editors' chunks import, and the JSON viewer's own theme names ".cm-lineNumbers" too, so
// the sentinel is in the shared chunk and the viewer's: lazy chunks only (checked just above),
// never more than those two.
{
  const carriers = chunksOf("datum-builder").filter((name) => read(name).includes(CODE_EDITOR));
  expect(carriers.length >= 1 && carriers.length <= 2, "one or two datum-builder-*.js chunks should carry the JSON editor (CodeMirror): the shared library chunk and the JSON viewer's");
}
// The formula editor is the builder's, in exactly one chunk: CodeMirror's own
// (shared with the JSON boxes) or one beside it. The eager pieces (the printer, the field list,
// the textarea fallback and its loader) stay in the module; the editor's classes do not.
expect(!builder.includes(FORMULA_EDITOR), "datum-builder.js (with its core chunk) carries the formula editor statically; it must stay in the lazy chunk the formula boxes load (formula-editor-loader.ts)");
expect(chunksOf("datum-builder").filter((name) => read(name).includes(FORMULA_EDITOR)).length === 1, "exactly one datum-builder-*.js chunk should carry the formula editor");
expect(!builder.includes(JOURNEY_DIAGNOSTICS), "datum-builder.js (with its core chunk) carries the journey diagnostics statically; `<datum-form debug>` and the Journeys designer load them from a lazy chunk");
// The Journeys designer: the mode, its catalog and the bar's control are in the
// module; the tree mapping, the Step view, the generator and the findings are a chunk it loads on
// first opening the side — one chunk, and the diagnostics in one chunk shared with `debug`'s.
expect(!builder.includes(JOURNEY_DESIGNER), "datum-builder.js (with its core chunk) carries the Journeys designer statically; it must stay in a lazy chunk the mode loads");
const journeyDesignerChunks = chunksOf("datum-builder").filter((name) => read(name).includes(JOURNEY_DESIGNER));
expect(journeyDesignerChunks.length === 1, "exactly one datum-builder-*.js chunk should carry the Journeys designer");
// The Step view (the one place a step is edited): the
// designer's chunk carries its words and its three modules (step-view, the canvas adapter, the history);
// the module and its core carry neither, and no other lazy chunk does.
expect(!builder.includes(JOURNEY_STEP_VIEW), "datum-builder.js (with its core chunk) carries the Journeys Step view's words statically; it must stay in the designer's lazy chunk");
expect(journeyDesignerChunks.every((name) => read(name).includes(JOURNEY_STEP_VIEW)), "the Journeys designer's chunk should carry the Step view's words");
expect(chunksOf("datum-builder").filter((name) => read(name).includes(JOURNEY_STEP_VIEW)).length === 1, "exactly one datum-builder-*.js chunk should carry the Journeys Step view");
expect(read("datum-builder.iife.js").includes(JOURNEY_STEP_VIEW), "datum-builder.iife.js should carry the Journeys Step view inline");
{
  const STEP_VIEW_SOURCE = /engine\/form-engine\/builder\/journey-designer\/step-(view|canvas-adapter|history)\.ts$/;
  expect(!sourcesOf("datum-builder.js").some((source) => STEP_VIEW_SOURCE.test(source)), "datum-builder.js.map names the Step view's sources; they belong in the designer's lazy chunk");
  for (const name of journeyDesignerChunks) {
    const bundled = new Set(sourcesOf(name).filter((source) => STEP_VIEW_SOURCE.test(source)).map((source) => /step-[a-z-]+/.exec(source)?.[0]));
    expect(bundled.size === 3, `${name}.map should name the Step view's three sources (step-view, step-canvas-adapter, step-history); it names ${[...bundled].join(", ") || "none"}`);
  }
  // A chunk with no source map of its own (the bundler's runtime) names no source.
  for (const name of chunksOf("datum-builder").filter((chunk) => !journeyDesignerChunks.includes(chunk) && existsSync(join(dist, `${chunk}.map`)))) {
    expect(!sourcesOf(name).some((source) => STEP_VIEW_SOURCE.test(source)), `${name}.map names the Step view's sources; they belong in the designer's chunk alone`);
  }
}
expect(chunksOf("datum-builder").filter((name) => read(name).includes(JOURNEY_DIAGNOSTICS)).length === 1, "exactly one datum-builder-*.js chunk should carry the journey diagnostics, shared by the designer and `debug`");
for (const name of journeyDesignerChunks) {
  expect(statSync(join(dist, name)).size <= JOURNEY_DESIGNER_CHUNK_BUDGET_KB * 1024, `${name} is over its ${JOURNEY_DESIGNER_CHUNK_BUDGET_KB} KB budget; the Journeys designer's chunk has taken in more than the designer`);
}
// The classic script has no chunks: it carries the designer inline, so a page without modules has journeys too.
expect(read("datum-builder.iife.js").includes(JOURNEY_DESIGNER), "datum-builder.iife.js should carry the Journeys designer inline");
// The journey flow map: neither in the module nor in the designer's chunk, which loads
// it; one chunk of its own, the diagnostics still in one shared chunk (checked above); inline in
// the classic script. The module names the map's surface only as [data-journey-map].
expect(!builder.includes(JOURNEY_MAP), "datum-builder.js (with its core chunk) carries the journey flow map statically; it must stay in a lazy chunk the designer loads");
for (const name of journeyDesignerChunks) {
  expect(!read(name).includes(JOURNEY_MAP), `${name} carries the journey flow map; it is a chunk of its own the designer loads on the first Map`);
}
const journeyMapChunks = chunksOf("datum-builder").filter((name) => read(name).includes(JOURNEY_MAP));
expect(journeyMapChunks.length === 1, "exactly one datum-builder-*.js chunk should carry the journey flow map");
for (const name of journeyMapChunks) {
  expect(!read(name).includes(JOURNEY_DESIGNER), `${name} carries the Journeys designer; the map is lent the words it needs`);
  expect(statSync(join(dist, name)).size <= JOURNEY_MAP_CHUNK_BUDGET_KB * 1024, `${name} is over its ${JOURNEY_MAP_CHUNK_BUDGET_KB} KB budget; the journey flow map's chunk has taken in more than the map`);
}
expect(read("datum-builder.iife.js").includes(JOURNEY_MAP), "datum-builder.iife.js should carry the journey flow map inline");
// The journey Try it runs: neither in the module nor in the
// designer's chunk, which loads it; one chunk of its own, carrying neither the designer
// (the designer lends it what it reads of it) nor the map; inline in the classic script. It
// words the Try panel's Journey card, a `try-card` like the panel's own, which the try-it chunk
// draws around it.
expect(!builder.includes(JOURNEY_PREVIEW), "datum-builder.js (with its core chunk) carries the journey try session statically; it must stay in a lazy chunk the designer loads");
for (const name of journeyDesignerChunks) {
  expect(!read(name).includes(JOURNEY_PREVIEW), `${name} carries the journey try session; it is a chunk of its own the designer loads ahead of Try it`);
}
const journeyPreviewChunks = chunksOf("datum-builder").filter((name) => read(name).includes(JOURNEY_PREVIEW));
expect(journeyPreviewChunks.length === 1, "exactly one datum-builder-*.js chunk should carry the journey try session");
for (const name of journeyPreviewChunks) {
  expect(!read(name).includes(JOURNEY_DESIGNER), `${name} carries the Journeys designer; the designer lends the try session what it reads of it`);
  expect(!read(name).includes(JOURNEY_MAP), `${name} carries the journey flow map; the map and the try session are chunks of their own`);
  expect(statSync(join(dist, name)).size <= JOURNEY_PREVIEW_CHUNK_BUDGET_KB * 1024, `${name} is over its ${JOURNEY_PREVIEW_CHUNK_BUDGET_KB} KB budget; the journey try session's chunk has taken in more than the session`);
}
for (const name of journeyMapChunks) {
  expect(!read(name).includes(JOURNEY_PREVIEW), `${name} carries the journey try session; the map never runs a journey`);
}
expect(read("datum-builder.iife.js").includes(JOURNEY_PREVIEW), "datum-builder.iife.js should carry the journey try session inline");
// The page-only fields: neither in the module nor in the designer's chunk,
// which loads them; one chunk of its own, carrying neither the designer (the designer
// lends it what it reads of it), the map nor the preview; inline in the classic script.
expect(!builder.includes(JOURNEY_AUTHORING), "datum-builder.js (with its core chunk) carries the page-only fields statically; they must stay in a lazy chunk the designer loads");
for (const name of [...journeyDesignerChunks, ...journeyMapChunks, ...journeyPreviewChunks]) {
  expect(!read(name).includes(JOURNEY_AUTHORING), `${name} carries the page-only fields; they are a chunk of their own the designer loads`);
}
const journeyAuthoringChunks = chunksOf("datum-builder").filter((name) => read(name).includes(JOURNEY_AUTHORING));
expect(journeyAuthoringChunks.length === 1, "exactly one datum-builder-*.js chunk should carry the page-only fields");
for (const name of journeyAuthoringChunks) {
  expect(!read(name).includes(JOURNEY_DESIGNER), `${name} carries the Journeys designer; the designer lends the page-only fields what they read of it`);
  expect(!read(name).includes(JOURNEY_STEP_VIEW), `${name} carries the Journeys Step view; it is in the designer's chunk`);
  expect(!read(name).includes(JOURNEY_MAP), `${name} carries the journey flow map`);
  expect(!read(name).includes(JOURNEY_PREVIEW), `${name} carries the Journeys preview`);
  expect(statSync(join(dist, name)).size <= JOURNEY_AUTHORING_CHUNK_BUDGET_KB * 1024, `${name} is over its ${JOURNEY_AUTHORING_CHUNK_BUDGET_KB} KB budget; the page-only fields' chunk has taken in more than their authoring`);
}
expect(read("datum-builder.iife.js").includes(JOURNEY_AUTHORING), "datum-builder.iife.js should carry the page-only fields inline");
// A lazy chunk that failed to load is loaded again. A browser keeps a failed
// import of a URL for the page's life, so the builder's module asks for a chunk through the
// function vite.config.ts appends (`retryableChunkImports`), under a new URL after a failure: no
// bare import("./…") is left in it. And a chunk asked for again under a new URL is the one its
// own chunks must read, so none the designer loads imports the designer's chunk.
for (const name of ["datum-builder.js", ...coreOf("datum-builder"), ...chunksOf("datum-builder")]) {
  expect(!/\bimport\(\s*["'`]\.\//.test(read(name)), `${name} loads a chunk by a bare import(); a failed load of it would never load again (vite.config.ts retryableChunkImports)`);
}
for (const name of [...journeyMapChunks, ...journeyPreviewChunks, ...journeyAuthoringChunks]) {
  for (const designer of journeyDesignerChunks) {
    expect(!read(name).includes(designer), `${name} imports the Journeys designer's chunk (${designer}); a designer loaded again after a failed load would leave it unable to load — the designer lends it what it reads`);
  }
}
expect(!builder.includes(KERNEL), "datum-builder.js (with its core chunk) carries the PDF executor statically; it must stay in a lazy chunk");
expect(chunksOf("datum-builder").filter((name) => read(name).includes(KERNEL)).length === 1, "exactly one datum-builder-*.js chunk should carry the PDF executor");
expect(!builder.includes(PDFJS), "datum-builder.js (with its core chunk) carries pdf.js statically; it must stay in a lazy chunk");
const builderPageChunks = chunksOf("datum-builder").filter((name) => read(name).includes(PDFJS));
expect(builderPageChunks.length === 1, "exactly one datum-builder-*.js chunk should carry pdf.js (the page imagery)");
expect(builderPageChunks.every((name) => !read(name).includes(KERNEL)), "the builder's pdf.js chunk must not carry the PDF executor too");

const pdf = read("datum-pdf.js");
expect(pdf.includes(KERNEL), "datum-pdf.js should carry the PDF executor");
expect(pdf.includes("createPdfSupport"), "datum-pdf.js should export createPdfSupport");
expect(!pdf.includes(CODE_EDITOR), "datum-pdf.js carries the builder's JSON editor (CodeMirror)");
expect(!pdf.includes(FORMULA_EDITOR), "datum-pdf.js carries the builder's formula editor");

expect(!pdf.includes(PDFJS), "datum-pdf.js carries pdf.js; page imagery is the builder's module");

// The page imagery module: pdf.js and its factory, no executor, and its assets beside it.
const pdfPages = read("datum-pdf-pages.js");
expect(pdfPages.includes(PDFJS), "datum-pdf-pages.js should carry pdf.js");
expect(pdfPages.includes("createPdfPageRasterizer"), "datum-pdf-pages.js should export createPdfPageRasterizer");
expect(!pdfPages.includes(KERNEL), "datum-pdf-pages.js carries the PDF executor; it only draws pages");
expect(existsSync(join(dist, "pdfjs", "pdf.worker.min.mjs")), "dist/pdfjs/pdf.worker.min.mjs is missing (copy-assets)");
expect(existsSync(join(dist, "pdfjs", "standard_fonts")), "dist/pdfjs/standard_fonts/ is missing (copy-assets)");
expect(!read("datum-pdf-program.js").includes(PDFJS), "datum-pdf-program.js carries pdf.js; a server never draws pages");

// The sandbox lives in datum-wasm.js alone: not in a bundle, not in a chunk, not in a classic script.
// Its program is also written out by itself (datum-sandbox-program.js) for a server's own QuickJS
// to evaluate: a plain script with both entry points, not a module.
const wasm = read("datum-wasm.js");
expect(wasm.includes(SANDBOX), "datum-wasm.js should carry the QuickJS sandbox");
expect(wasm.includes("createWasmValidationHost"), "datum-wasm.js should export createWasmValidationHost");
const program = read("datum-sandbox-program.js");
expect(program.includes(SANDBOX) && program.includes("__datum_run"), "datum-sandbox-program.js should carry the sandbox program's entry points");
expect(isPlainScript(program), "datum-sandbox-program.js must be a plain script a QuickJS context evaluates, not a module");
for (const name of files.filter((name) => name !== "datum-wasm.js" && name !== "datum-sandbox-program.js")) {
  expect(!read(name).includes(SANDBOX), `${name} carries the QuickJS sandbox; it belongs in datum-wasm.js alone`);
}

// The PDF program beside the bundles: the executor with its own entry points, as a
// plain script, for a server that renders the same PDF in a QuickJS of its own.
const pdfProgram = read("datum-pdf-program.js");
expect(pdfProgram.includes(KERNEL) && pdfProgram.includes("__datum_pdf") && pdfProgram.includes("__datum_pdf_register"), "datum-pdf-program.js should carry the PDF program's executor and entry points");
expect(isPlainScript(pdfProgram), "datum-pdf-program.js must be a plain script a QuickJS context evaluates, not a module");
expect(!pdfProgram.includes(SANDBOX), "datum-pdf-program.js carries the validation sandbox; the two programs ship apart");
// Signing is the executor's: in the program and the lazy PDF chunk, never in the classic form bundle.
expect(pdfProgram.includes(SIGNER), "datum-pdf-program.js should carry the signature pass; a stale copy lacks the signing step");
expect(!form.includes(SIGNER), "datum-form.js (with its core chunk) carries the PDF signature pass; it belongs in the executor's chunk");
expect(pdf.includes(SIGNER), "datum-pdf.js should carry the signature pass beside the executor");

// The agent chunks' source maps: the text sentinels above and in guard 15 say what a file
// spells, the maps say which sources went into it. A map lists every module a chunk bundled, so a leak that renames its
// strings (Rollup minifies internal names) still shows up here. `engine/form-engine/` prefixes are matched without the
// leading ../ the maps carry.
{
  // The planner and the languages model are shared chunks: never in the entry or the main agent chunk.
  const PLANNER = "engine/form-engine/builder/data/data-model-plan.ts";
  const LANGUAGES_MODEL = "engine/form-engine/builder/languages/languages-model.ts";
  const mainAgent = chunksOf("datum-builder").filter((name) => /^datum-builder-agent-[^/]+\.js$/.test(name));
  const bodyAgents = chunksOf("datum-builder").filter((name) => name.startsWith("datum-builder-agentpart-") && name.endsWith(".js"));
  const formAgent = chunksOf("datum-form").filter((name) => /^datum-form-agent-[^/]+\.js$/.test(name));
  expect(mainAgent.length === 1 && formAgent.length === 1 && bodyAgents.length === 3, `expected one main agent chunk per bundle and three builder body chunks; found ${mainAgent.length} builder, ${formAgent.length} form, ${bodyAgents.length} body`);
  // The entries carry the agent loader only: no tool, registrar, binding or element host.
  for (const entry of ["datum-builder.js", "datum-form.js"]) {
    const leaked = sourcesOf(entry).filter((source) => /engine\/form-engine\/agent\//.test(source) || /^src\/(agent|agent-host|agent-ui|agent-attach)\.ts$/.test(source) || /^src\/builder\/agent/.test(source));
    expect(leaked.length === 0, `${entry}.map names agent sources (${leaked.slice(0, 3).join(", ")}); the agent layer is the lazy chunks'`);
  }
  for (const source of [PLANNER, LANGUAGES_MODEL]) {
    expect(!sourcesOf("datum-builder.js").includes(source), `datum-builder.js.map names ${source}; it is a shared chunk the agent and its surface load`);
    for (const name of mainAgent) {
      expect(!sourcesOf(name).includes(source), `${name}.map names ${source}; the main agent chunk reaches it through its loader`);
    }
  }
  const MAIN_AGENT_FORBIDDEN = [
    /^engine\/form-engine\/builder\/data-model\//,
    /^engine\/form-engine\/builder\/web-component\/try-it\.ts$/,
    /^engine\/form-engine\/agent\/answers\//,
    /\/agentpart-[a-z]+\.ts$/,
    // The body-only helpers (<area>-*.ts) and the mode modules with their designers: a value import from tools.ts would drag one in.
    /^engine\/form-engine\/agent\/builder\/(try|languages|documents)-[a-z-]+\.ts$/,
    /^engine\/form-engine\/builder\/pdf-designer\//,
    /^engine\/form-engine\/builder\/journey-designer\//,
    /(pdf|journey)-builder-mode\.ts$/
  ];
  for (const name of mainAgent) {
    const leaked = sourcesOf(name).filter((source) => MAIN_AGENT_FORBIDDEN.some((pattern) => pattern.test(source)));
    expect(leaked.length === 0, `${name}.map names ${leaked.slice(0, 3).join(", ")}; the main builder agent chunk carries the catalogue, never a body, a mode, Try it or the renderer's answers code`);
  }
  for (const name of formAgent) {
    const leaked = sourcesOf(name).filter((source) => /engine\/form-engine\/agent\/builder\//.test(source) || source === "engine/form-engine/render/pdf/pdf-layout-selection.ts");
    expect(leaked.length === 0, `${name}.map names ${leaked.slice(0, 3).join(", ")}; the form agent chunk carries neither the builder's tools nor the PDF layout selection`);
  }
  // A body chunk bundles its own module, the helpers only it imports (<area>-*.ts) and, for Try it, the renderer's answers code.
  for (const name of bodyAgents) {
    const area = /^datum-builder-agentpart-([a-z]+)-/.exec(name)?.[1];
    const allowed = [new RegExp(`^engine/form-engine/agent/builder/agentpart-${area}\\.ts$`), new RegExp(`^engine/form-engine/agent/builder/${area}-[a-z-]+\\.ts$`), ...(area === "try" ? [/^engine\/form-engine\/agent\/answers\//] : [])];
    const stray = sourcesOf(name).filter((source) => !allowed.some((pattern) => pattern.test(source)));
    expect(stray.length === 0, `${name}.map names ${stray.slice(0, 3).join(", ")}; a body chunk carries its own module and helpers only (a shared module belongs in a shared chunk)`);
  }
}

// Core holds no binding and no plugin: a package that describes itself ("datumBinding",
// "datumPlugin") is a bundle of its own, registered by the page, so this package and the engine may
// not depend on one (an import of it would land in these bundles).
for (const owner of [join(dist, ".."), join(dist, "..", "..", "..", "engine")]) {
  const manifest = JSON.parse(readFileSync(join(owner, "package.json"), "utf8"));
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies })) {
    const file = join(owner, "node_modules", name, "package.json");
    if (!existsSync(file)) continue;
    const linked = JSON.parse(readFileSync(file, "utf8"));
    expect(!linked.datumBinding && !linked.datumPlugin, `${manifest.name} depends on ${name}, a binding or plugin package: core depends on none (a page registers it from its own bundle)`);
  }
}

await runGuards(guards, { dist, files, read, chunksOf, expect, sizeKb: (name) => statSync(join(dist, name)).size / 1024, entryText, entryKb, sourcesOf, coreOf }, problems);

for (const name of files.sort()) {
  console.log(`check-bundles: ${name.padEnd(44)} ${String(Math.round(statSync(join(dist, name)).size / 1024)).padStart(6)} KB`);
}
for (const name of ["datum-form.js", "datum-builder.js"]) {
  console.log(`check-bundles: ${`${name} + core`.padEnd(44)} ${String(Math.round(entryKb(name))).padStart(6)} KB, ${pairGzip(name)} B gzip (gated at ${GZIP_BASE[name] + GZIP_ALLOWANCE} B)`);
}
if (problems.length > 0) {
  console.error(`check-bundles: ${problems.join("; ")}`);
  process.exit(1);
}
console.log("check-bundles: ok");
