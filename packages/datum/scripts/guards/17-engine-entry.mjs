// The engine entry, datum-engine.js (src/engine.ts): the form runtime with no element, for plain
// Node, a web worker or a test runner without a DOM. What the guard holds:
//   - it is one file: no chunk of its own, no static or dynamic import of another file;
//   - its source map names no element module (any *-element.ts), no part of the live renderer or a
//     binding (render/live/, bindings/, lit-html), no drawing pipeline (render/pdf/, render/print/),
//     no builder surface, and of this package's own sources only the DOM-free ones listed below;
//   - its text names no DOM global (document, window, customElements, HTMLElement) at all, so
//     nothing reads one when the module loads (tests/engine-entry.test.ts imports it in plain Node);
//     the one sentence of prose that names "document" (the server validator's refusal, which means
//     the envelope) is read out first;
//   - it carries the journeys runtime (the eager engine, by its name), statically, and none of the
//     journey's drawing: no render kit, no page module, no Check answers list;
//   - it carries neither the validation sandbox nor the PDF kernel.
// The other bundles are built apart from it (vite.config.ts, scripts/build-bundles.mjs), so
// adding it moves none of their bytes.

/**
 * This package's sources the entry may reach: the runtime factory and what it is built from, and
 * the fetch-only journey server validator (with its error class), which the element's bundle
 * reaches by dynamic import and this entry statically.
 */
const PACKAGE_SOURCES = new Set([
  "src/engine.ts",
  "src/runtime-factory.ts",
  "src/standard-components.ts",
  "src/plugins.ts",
  "src/support.ts",
  "src/server-validator.ts",
  "src/server-validator-error.ts"
]);
/** The journeys runtime's modules the entry must carry: the eager engine and what only it reaches. */
const JOURNEY_SOURCES = [
  "engine/form-engine/runtime/browser/journey-engine-eager.ts",
  "engine/form-engine/runtime/browser/journey/journey-navigation.ts",
  "engine/form-engine/runtime/browser/journey/journey-server-checks.ts",
  "engine/form-engine/core/journey/journey-path.ts"
];
/** The eager engine's name, read back by the runtime: the journeys runtime is in the file. */
const JOURNEY_ENGINE = "datum-journey-engine-eager";
/** Prose in the file that names a DOM global's word without reading it. */
const PROSE = ["No document to post to"];
/** The engine's render/web-component/ modules the runtime reads that draw nothing. */
const WEB_COMPONENT_HELPERS = new Set(["engine/form-engine/render/web-component/typed-answers.ts"]);
const FORBIDDEN = [
  [/-element\.ts$/, "an element module"],
  [/^engine\/form-engine\/render\/live\//, "the live renderer or a binding"],
  [/^bindings\//, "a design-system binding"],
  [/(^|\/)node_modules\/lit(-html)?\//, "lit-html"],
  [/^engine\/form-engine\/render\/(pdf|print)\//, "a drawing pipeline (PDF or print)"],
  [/^engine\/form-engine\/builder\/(web-component|journey-designer|pdf-designer|logic|data|languages)\//, "a builder surface"],
  [/^engine\/form-engine\/agent\//, "the agent tools"],
  [/^engine\/form-engine\/render\/core\/journey-(render|review)/, "a journey's drawing (the render kit or the Check answers list)"],
  [/^src\/journey-(engine|review)-(chunk|loader)\.ts$/, "the element's journeys chunk or its loader"]
];
const DOM_GLOBALS = ["document", "window", "customElements", "HTMLElement"];
const SANDBOX = "__datum_register"; // the QuickJS sandbox program (check-bundles.mjs SANDBOX)
const KERNEL = "PDFAcroForm"; // pdf-lib (check-bundles.mjs KERNEL)

// Measured with the journeys runtime in: 315,512 B (308.1 KB), plus 3 KB, rounded up.
export const budgets = { "datum-engine.js": 312 };

export default function guard({ files, read, expect, sourcesOf }) {
  const name = "datum-engine.js";
  expect(files.includes(name), `dist/${name} is missing; scripts/build-bundles.mjs builds it (--mode engine)`);
  if (!files.includes(name)) {
    return;
  }
  expect(!files.some((file) => file.startsWith("datum-engine-")), "datum-engine.js has chunks beside it; the entry is one file (vite.config.ts codeSplitting: false)");
  const text = PROSE.reduce((left, prose) => left.split(prose).join(""), read(name));
  expect(!/\bimport\s*\(/.test(text), "datum-engine.js imports a file at run time; the entry is one file");
  expect(!/(?:from|import)\s*["'`]\.{0,2}\//.test(text), "datum-engine.js imports another file statically; the entry is one file");
  for (const global of DOM_GLOBALS) {
    expect(!new RegExp(`(?<![A-Za-z0-9_$."'])${global}(?![A-Za-z0-9_$"':])`).test(text), `datum-engine.js names the DOM global ${global}; the entry must load and run with no DOM`);
  }
  expect(!text.includes(SANDBOX), "datum-engine.js carries the validation sandbox; it is datum-wasm.js's alone");
  expect(!text.includes(KERNEL), "datum-engine.js carries the PDF kernel; it is datum-pdf.js's");
  expect(text.includes(JOURNEY_ENGINE), "datum-engine.js does not carry the journeys runtime; src/engine.ts builds every runtime with EagerJourneyEngine");
  const sources = sourcesOf(name);
  for (const source of JOURNEY_SOURCES) {
    expect(sources.includes(source), `datum-engine.js.map does not name ${source}; the journeys runtime is part of the entry`);
  }
  for (const source of sources) {
    if (source.startsWith("src/")) {
      expect(PACKAGE_SOURCES.has(source), `datum-engine.js.map names ${source}; the entry reaches only the runtime factory and its DOM-free sources (guards/17-engine-entry.mjs)`);
      continue;
    }
    if (source.startsWith("engine/form-engine/render/web-component/")) {
      expect(WEB_COMPONENT_HELPERS.has(source), `datum-engine.js.map names ${source}, a module of the form element's; the entry draws nothing`);
      continue;
    }
    for (const [pattern, what] of FORBIDDEN) {
      expect(!pattern.test(source), `datum-engine.js.map names ${source}, ${what}; drawing stays behind the element`);
    }
  }
}
