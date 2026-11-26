// The renderer's PDF glue split. datum-form.js must not carry two whole
// engine modules for a handful of symbols each: render/pdf/pdf-theme.ts (the theme merge, scale
// and selection, 17.7 KB) and core/schema/pdf-layout.ts (every resolver of the layout schema,
// 15.1 KB). Rollup places a module in one chunk, so the entry carried each module's whole
// retained body. Both are split:
//
// - pdf-theme-defaults.ts (DEFAULT_PDF_THEME, PLAIN_PDF_THEME: the theme registry registers them
//   when the bundle loads, and `themes.pdfLookup` answers from it synchronously) stays in the
//   entry; pdf-theme.ts (resolvePdfTheme, selectPdfTheme) loads with the PDF service.
// - pdf-layout-read.ts (the reader and validator `pdfLayouts()` lists layouts with) and
//   pdf-layout-table.ts (the slots the generic tree walk names) stay in the entry; the page-setup,
//   conformance, signature and area resolvers in pdf-layout.ts load with the PDF service.
//
// Each part is told by the module paths in the source maps (never by a string: "contactInfo", the
// signature resolver's field list, is also a schema field name that pdf-layout-read.ts spells, and
// those modules legitimately ride in the entry), and the theme logic also by "theme.notFound", the
// warning code of selectPdfTheme, a string only that module spells. The classic script
// (datum-form.iife.js) cannot split chunks (Vite inlines a dynamic import in an IIFE) and stays out
// of the must-not-contain checks; it does not shrink, which is no regression.
const THEME_LOGIC = "theme.notFound";
const THEME_LOGIC_MODULE = "engine/form-engine/render/pdf/pdf-theme.ts";
const LAYOUT_RESOLVERS_MODULE = "engine/form-engine/core/schema/pdf-layout.ts";
// The signature block's reader is the PDF service's alone: it has its own module, so that the
// table-slot helpers the renderer's shells import from pdf-layout.ts do not drag it into the core chunk.
const SIGNATURE_READER_MODULE = "engine/form-engine/core/schema/pdf-signature-configuration.ts";
// What must stay in the entry: the two shipped PDF themes' ids (the registry registers them at
// load, `themes.resolvePdf("default")` is DEFAULT_PDF_THEME itself).
const EAGER = ["datum-pdf", "datum-plain"];

// datum-form.js (with its core chunk) is held to the gzip gate in check-bundles.mjs.

// The renderer's PDF service chunk carries the theme and layout logic: measured 81.3 KB, plus 2 KB,
// rounded up. It equals FORM_PDF_CHUNK_BUDGET_KB in check-bundles.mjs, which must be raised to match.
const PDF_SERVICE_CHUNK_BUDGET_KB = 84;

export default function guard({ entryText, read, chunksOf, expect, sizeKb, sourcesOf, coreOf }) {
  const entry = entryText("datum-form.js");
  const initial = sourcesOf("datum-form.js");
  // The theme selection logic: not in the initial payload (the entry and its core chunk), once in a lazy chunk, and that chunk is the PDF service.
  expect(!entry.includes(THEME_LOGIC), `datum-form.js (with its core chunk) carries the PDF theme selection logic (${THEME_LOGIC}); it belongs in the PDF service chunk`);
  expect(!initial.includes(THEME_LOGIC_MODULE), `datum-form.js (with its core chunk) names ${THEME_LOGIC_MODULE} in its source maps; the theme selection logic belongs in the PDF service chunk`);
  const carriers = chunksOf("datum-form").filter((name) => name.endsWith(".js") && read(name).includes(THEME_LOGIC));
  expect(carriers.length === 1, `exactly one datum-form-*.js chunk should carry the PDF theme selection logic (pdf-theme.ts); found ${carriers.length}`);
  for (const name of carriers) {
    expect(/^datum-form-pdf-service-.+\.js$/.test(name), `${name} carries the PDF theme selection logic (pdf-theme.ts); it belongs in the PDF service chunk`);
    expect(sourcesOf(name).includes(THEME_LOGIC_MODULE), `${name}.map should name ${THEME_LOGIC_MODULE}`);
    expect(sizeKb(name) <= PDF_SERVICE_CHUNK_BUDGET_KB, `${name} is ${sizeKb(name).toFixed(1)} KB, over its ${PDF_SERVICE_CHUNK_BUDGET_KB} KB budget`);
  }
  // The layout resolvers (core/schema/pdf-layout.ts) are held by the source maps, never by a text sentinel (see the header).
  // Since the Vite 8 / Rolldown build the module sits in the entry's core chunk, not in the PDF service chunk: both the entry
  // and the service reach it, and Rolldown puts a module two chunks share in the shared chunk (about 5.8 KB of its
  // resolvers, by the core map's mappings; Rollup kept it out of the entry). What is held is that it is carried
  // once, not twice, among the core and lazy chunks of datum-form. Moving it back out of the initial payload takes the
  // layout module's shared imports out of the entry's reach (an engine and vite.config.ts matter, not this guard).
  expect(!initial.includes(SIGNATURE_READER_MODULE), `datum-form.js (with its core chunk) carries ${SIGNATURE_READER_MODULE}; the signature reader belongs in the PDF service chunk`);
  const readerCarriers = chunksOf("datum-form").filter((name) => sourcesOf(name).includes(SIGNATURE_READER_MODULE));
  expect(readerCarriers.length === 1 && /^datum-form-pdf-service-.+\.js$/.test(readerCarriers[0]), `${SIGNATURE_READER_MODULE} should be carried by the PDF service chunk alone; found ${readerCarriers.join(", ") || "none"}`);
  const layoutCarriers = [...coreOf("datum-form"), ...chunksOf("datum-form")].filter((name) => sourcesOf(name).includes(LAYOUT_RESOLVERS_MODULE));
  expect(layoutCarriers.length === 1, `${LAYOUT_RESOLVERS_MODULE} (the PDF layout resolvers) should be carried by exactly one of the core and lazy chunks' source maps of datum-form; found ${layoutCarriers.length}${layoutCarriers.length ? ` (${layoutCarriers.join(", ")})` : ""}`);
  for (const id of EAGER) {
    expect(entry.includes(`"${id}"`), `datum-form.js (with its core chunk) lost the shipped PDF theme id "${id}"; the theme registry registers it at load`);
  }
  // The builder's preview copy follows its own graph and is not held here; a page-level classic
  // script carries the PDF code inline.
  expect(read("datum-form.iife.js").includes(THEME_LOGIC), "datum-form.iife.js should carry the PDF theme logic inline");
}
