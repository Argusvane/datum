// The journeys runtime is a lazy chunk.
// `datum-form.js` must not carry the journey machinery: the path engine, the navigation,
// the server checks and the presentation overlay in FormRuntime, and the page chrome in the
// renderer (journey-render, journey-markup). Those sit behind two seams, the runtime's
// `JourneyEngine` and the renderer's `JourneyRenderKit`, whose Noop defaults the entry carries;
// the real ones are the entry module of `datum-form-journey-engine-chunk-*.js`
// (src/journey-engine-chunk.ts), which `loadJourneyEngine()` imports on the first journey form.
//
// `<datum-form>` loads the chunk for a form with journeys (the async build, form-element.ts) and
// hands the engine and the kit to the runtime and the renderer it builds; nothing registers
// them as the page's defaults in this bundle.
//
// What the guard holds:
//   - the chunk exists, carries the sentinel string, and only one datum-form-*.js file does;
//   - it stays inside its size budget (below);
//   - the strings only the moved modules spell are absent from `datum-form.js` and present in a
//     datum-form-*.js chunk, and the entry keeps the Noop pair's default slots;
//   - the entry's size is the gzip gate's (check-bundles.mjs);
//   - the Check answers chunk (below) exists, within its own budget, and its code is neither in
//     the entry nor in the journeys chunk.
// The classic scripts (datum-form.iife.js) cannot code-split (Vite inlines a dynamic import in
// an IIFE), so they carry everything and stay out of the must-not-contain checks.

/** The chunk's own marker (src/journey-engine-chunk.ts: JOURNEY_ENGINE_SENTINEL). */
const CHUNK_SENTINEL = "datum-journey-engine-chunk";

// Strings only the moved modules spell, each found by looking for text that is absent from a build whose entry holds the Noop pair and present in
// the chunk: the eager engine's and kit's own ids, the checker's messages and its state names
// (journey-server-checks.ts), the check-in-progress status markup (journey-markup.ts) and a
// field of the path engine's result (journey-path.ts: `membersOf`; the journey diagnostics read
// the field too, so it may also be spelt in the diagnostics chunk, which is why that entry is
// marked "some") and a field of the page view the render kit builds (journey-render.ts:
// `backPageId`; the file spells no string literal of its own). Each must sit in the journeys
// runtime chunk itself. Not usable: "@presentation" and "journey-field", which the entry spells
// itself (the orchestrator's presentation-key test, the definition readers), and "hasOwnSubmit",
// which the Noop kit spells.
const MOVED = [
  ["the eager journey engine (journey-engine-eager.ts)", "datum-journey-engine-eager"],
  ["the eager render kit (journey-render-kit-eager.ts)", "datum-journey-render-kit-eager"],
  ["the journey server checker (journey-server-checks.ts)", "The check was called off."],
  ["the journey server checker's end check (journey-server-checks.ts)", "journey_end_unavailable"],
  // The live renderer's journey page module (render/live/journey-page.ts) draws the page: its hook labels are spelt only there.
  ["the journey page module (journey-page.ts)", "page.heading"],
  ["the journey path engine (journey-path.ts)", "membersOf", "some"],
  ["the journey page actions (journey-page.ts)", "page.actions"]
];

// Budgets, in KB. The renderer has exactly ONE journeys file: the path engine sits in
// the runtime chunk because src/journey-diagnostics.ts reads a binding of it, which makes the
// diagnostics chunk import the runtime chunk instead of sharing a third file with it. The
// journeys chunk draws the page through the live renderer (journey-page.ts, the page adapters): measured 50.1 KB, plus 2 KB, rounded up → 53 KB.
const CHUNK_BUDGETS_KB = [[/^datum-form-journey-engine-chunk-.+\.js$/, 53]];
const RUNTIME_BUDGET_KB = 53;
const RUNTIME_FILES = /^datum-form-journey-(engine-chunk|path)-.+\.js$/;

// datum-form.js (with its core chunk) is held to the gzip gate in check-bundles.mjs.

// A journey's Check answers page (`kind: "review"`) is a chunk of its own,
// `datum-form-journey-review-chunk-*.js` (src/journey-review-chunk.ts): the list's model
// (render/core/journey-review.ts), its live drawing and Datum's sheet for it
// (render/live/journey-review.ts) and the kit over them (render/core/journey-review-kit-eager.ts).
// Only a journey with such a page loads it (`<datum-form>` beside the journeys chunk), so neither the
// entry nor the journeys chunk may carry any of it: told by its strings and by the source maps.
const REVIEW_CHUNK = /^datum-form-journey-review-chunk-.+\.js$/;
/** The chunk's own marker (src/journey-review-chunk.ts: JOURNEY_REVIEW_SENTINEL). */
const REVIEW_SENTINEL = "datum-journey-review-chunk";
/** Strings only the Check answers code spells. */
const REVIEW_CODE = [
  ["the Check answers kit (journey-review-kit-eager.ts)", "datum-journey-review-kit-eager"],
  ["Datum's Check answers list (render/live/journey-review.ts)", "datum-form__review-list"]
];
/** The modules only the Check answers chunk may bundle. */
const REVIEW_SOURCES = [
  "engine/form-engine/render/core/journey-review.ts",
  "engine/form-engine/render/live/journey-review.ts",
  "engine/form-engine/render/core/journey-review-kit-eager.ts"
];
// Split out of the journeys chunk so that chunk stays under its 53 KB budget: measured 14,232 B
// (13.9 KB; 5,314 B gzip), plus about 1 KB, rounded up. Its answer text (print/field-answer.ts) is
// a small chunk it shares with print. The journeys chunk loads it, not the entry: any chunk that
// shares lit-html, the error wording and the kinds with the entry moves them to the core chunk
// (about 120 B gzip on datum-form.js with its core), and a loader and check in the entry as well
// (about 140 B) would take the pair over its gzip gate.
const REVIEW_CHUNK_BUDGET_KB = 15;

export default function guard({ entryText, files, read, chunksOf, expect, sizeKb, sourcesOf }) {
  const entry = entryText("datum-form.js");
  const chunks = chunksOf("datum-form").filter((name) => name.endsWith(".js"));

  // The chunk is there, once, and the sentinel is in it alone.
  // One journey file to deploy, retry and delete: the path engine is not a chunk of its own.
  const strays = files.filter((name) => /^datum-form-journey-path-.+\.js$/.test(name));
  expect(strays.length === 0, `the path engine must live in the journeys runtime chunk, not in a file of its own (${strays.join(", ")}); src/journey-diagnostics.ts has to read a binding of src/journey-engine-chunk.ts so the two chunks are linked`);
  const carriers = chunks.filter((name) => read(name).includes(CHUNK_SENTINEL));
  expect(carriers.length === 1, `exactly one datum-form-*.js chunk should carry the journeys runtime sentinel (${CHUNK_SENTINEL}); found ${carriers.length}`);
  for (const name of carriers) {
    expect(/^datum-form-journey-engine-chunk-.+\.js$/.test(name), `${name} carries the journeys runtime sentinel; the chunk should be named datum-form-journey-engine-chunk-*.js (scripts/feature-files.mjs attributes it to \`journeys\` by that name)`);
  }
  expect(!entry.includes(CHUNK_SENTINEL), "datum-form.js (with its core chunk) carries the journeys runtime sentinel; the chunk's entry module must be reached by dynamic import alone (src/journey-engine-loader.ts)");
  expect(files.some((name) => /^datum-form-journey-engine-chunk-.+\.js$/.test(name)), "datum-form-journey-engine-chunk-*.js chunk is missing");
  for (const [pattern, limit] of CHUNK_BUDGETS_KB) {
    for (const name of files.filter((name) => pattern.test(name))) {
      expect(sizeKb(name) <= limit, `${name} is ${sizeKb(name).toFixed(1)} KB, over its ${limit} KB budget; the journeys chunk has grown`);
    }
  }
  const runtimeFiles = files.filter((name) => RUNTIME_FILES.test(name));
  const runtimeKb = runtimeFiles.reduce((total, name) => total + sizeKb(name), 0);
  expect(runtimeKb <= RUNTIME_BUDGET_KB, `the journeys runtime a journey form loads (${runtimeFiles.join(", ")}) is ${runtimeKb.toFixed(1)} KB, over its ${RUNTIME_BUDGET_KB} KB budget`);

  const runtimeChunk = chunks.find((name) => /^datum-form-journey-engine-chunk-.+\.js$/.test(name));
  for (const [label, text, how = "one"] of MOVED) {
    expect(!entry.includes(text), `datum-form.js (with its core chunk) carries ${label} (${JSON.stringify(text)}); it belongs in the journeys chunk`);
    expect(runtimeChunk !== undefined && read(runtimeChunk).includes(text), `the journeys runtime chunk (${runtimeChunk}) should carry ${label} (${JSON.stringify(text)})`);
    const holding = chunks.filter((name) => read(name).includes(text));
    expect(how === "one" ? holding.length === 1 : holding.length >= 1, `${how === "one" ? "exactly one" : "at least one"} datum-form-*.js chunk should carry ${label}; found ${holding.length}`);
  }
  // The Check answers chunk: there, once, within its budget; its code nowhere else a form loads.
  const reviewCarriers = chunks.filter((name) => read(name).includes(REVIEW_SENTINEL));
  expect(reviewCarriers.length === 1 && REVIEW_CHUNK.test(reviewCarriers[0]), `exactly one datum-form-*.js chunk, named datum-form-journey-review-chunk-*.js, should carry the Check answers sentinel (${REVIEW_SENTINEL}); found ${reviewCarriers.join(", ") || "none"}`);
  const reviewChunk = chunks.find((name) => REVIEW_CHUNK.test(name));
  expect(!entry.includes(REVIEW_SENTINEL), "datum-form.js (with its core chunk) carries the Check answers sentinel; the chunk's entry module must be reached by dynamic import alone (src/journey-review-loader.ts)");
  for (const [label, text] of REVIEW_CODE) {
    expect(!entry.includes(text), `datum-form.js (with its core chunk) carries ${label} (${JSON.stringify(text)}); it belongs in the Check answers chunk`);
    expect(runtimeChunk === undefined || !read(runtimeChunk).includes(text), `the journeys runtime chunk (${runtimeChunk}) carries ${label} (${JSON.stringify(text)}); it belongs in the Check answers chunk, which only a journey with a Check answers page loads`);
    expect(reviewChunk !== undefined && read(reviewChunk).includes(text), `the Check answers chunk (${reviewChunk}) should carry ${label} (${JSON.stringify(text)})`);
    const holding = chunks.filter((name) => read(name).includes(text));
    expect(holding.length === 1, `exactly one datum-form-*.js chunk should carry ${label}; found ${holding.length} (${holding.join(", ")})`);
  }
  for (const source of REVIEW_SOURCES) {
    expect(!sourcesOf("datum-form.js").includes(source), `datum-form.js.map (with its core chunk) names ${source}; it belongs in the Check answers chunk`);
    expect(runtimeChunk === undefined || !sourcesOf(runtimeChunk).includes(source), `${runtimeChunk}.map names ${source}; it belongs in the Check answers chunk`);
    expect(reviewChunk !== undefined && sourcesOf(reviewChunk).includes(source), `the Check answers chunk's map (${reviewChunk}.map) should name ${source}`);
  }
  // The entry asks for it beside the journeys chunk (the journeys chunk reaches it through the same
  // loader, for a host's `forDefinition` call with no bundle handed in), and it imports nothing of
  // the journeys chunk (a chunk asked for again under a new URL after a failed load is its own copy).
  if (reviewChunk !== undefined) {
    expect(entry.includes(reviewChunk), `datum-form.js (with its core chunk) should name ${reviewChunk}: it fetches it beside the journeys chunk for a journey with a Check answers page (src/journey-review-loader.ts)`);
    expect(runtimeChunk === undefined || !read(reviewChunk).includes(runtimeChunk), `${reviewChunk} imports the journeys runtime chunk (${runtimeChunk}); it is handed what it needs`);
  }
  if (reviewChunk !== undefined) {
    expect(sizeKb(reviewChunk) <= REVIEW_CHUNK_BUDGET_KB, `${reviewChunk} is ${sizeKb(reviewChunk).toFixed(1)} KB, over its ${REVIEW_CHUNK_BUDGET_KB} KB budget; the Check answers chunk has grown`);
  }
  // The classic script has no chunks: it carries the Check answers page inline.
  expect(read("datum-form.iife.js").includes(REVIEW_CODE[1][1]), "datum-form.iife.js should carry the Check answers list inline");

  // The Noop pair stays in the entry: a form with no journeys draws and runs through it.
  expect(entry.includes("datum.journeyEngine.default") && entry.includes("datum.journeyRenderKit.default"), "datum-form.js (with its core chunk) should keep the default-engine and default-kit slots (the Noop pair)");
}
