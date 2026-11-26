// The builder's PDF and Journeys modes as lazy chunks. <datum-form-builder>
// fetches the PDF mode (pdf-mode-loader.ts) only while its PDF side is on and the PDF workspace
// shown, and the Journeys mode (journey-mode-loader.ts) likewise; until then neither is in the
// builder's module. Each sentinel is a class only that mode's stylesheet and markup spell.
// The classic script (datum-builder.iife.js) carries both inline, like every other builder chunk.
//
// With the PDF mode out of the module, the PDF render pipeline (pdf-service.ts, renderFormPdf)
// the mode imported statically left it too: a chunk the mode, Try it's Preview PDF and the
// canvas's form share, as the renderer's own lazy PDF chunk is for datum-form.js.
//
// A form rename is followed into the definition's layouts and journeys while a mode is not
// registered (off, hidden, coming, failed) by eager code: renamePdfLayoutConditions
// (layout-conditions.ts) and journey-config-rename.ts, both imported statically by
// builder-element.ts, so they cannot leave datum-builder.js; the JOURNEY_MODE check below is what
// proves that following a rename did not pull the Journeys mode back in.

const PDF_MODE = "pdf-empty-add"; // the data-pdf-empty-add hook on the PDF mode's no-layout card's Add button (pdf-builder-mode.ts, its markup and click handler)
const JOURNEY_MODE = "journey-load-note"; // the Journeys mode's map-loading note (journey-builder-mode.ts JOURNEY_BUILDER_MODE_STYLES)
const PIPELINE = "mapping.unresolved"; // render/pdf/pdf-template.ts, the PDF render pipeline (check-bundles.mjs's PIPELINE)

// The PDF mode: measured 62,535 B (61.1 KB), plus 3 KB, rounded up. It carries the agent seams
// (previewReport split out of showPreview with its quiet dialog, suggestMappings' batch and
// createFormFields' around, applyCatalogForAgent, openState and whenOpenReady), the prune stash
// the designer's Undo restores and the one-step undo of a layout block with the map.
const PDF_MODE_CHUNK_BUDGET_KB = 65;
// The Journeys mode: measured 64,951 B (63.4 KB), plus about 1 KB, rounded up. It carries the agent
// seams for journeys, the Logic host for Go to rules (open-from-map and new-rule-from-map requests,
// the registry beside the form's controller), the Step view's seams, the findings card, the Form
// fields panel's rows and the Try it map marks.
const JOURNEY_MODE_CHUNK_BUDGET_KB = 65;
// The builder's PDF pipeline chunk: 69.1 KB measured with the PDF render caps, the attachment-name
// and attachment-type checks, the decoded-length size check and the sniffer; lazy chunks get measured + 2.
const PIPELINE_CHUNK_BUDGET_KB = 72;

// datum-builder.js (with its core chunk) is held to the gzip gate in check-bundles.mjs.

export default function guard({ entryText, read, chunksOf, expect, sizeKb }) {
  const builder = entryText("datum-builder.js");
  const form = entryText("datum-form.js");
  for (const [sentinel, what, budget] of [
    [PDF_MODE, "the PDF mode", PDF_MODE_CHUNK_BUDGET_KB],
    [JOURNEY_MODE, "the Journeys mode", JOURNEY_MODE_CHUNK_BUDGET_KB]
  ]) {
    expect(!builder.includes(sentinel), `datum-builder.js (with its core chunk) carries ${what} statically (${sentinel}); it must stay in the lazy chunk its loader fetches`);
    expect(!form.includes(sentinel), `datum-form.js (with its core chunk) carries ${what} (${sentinel}); the renderer has no builder modes`);
    for (const name of chunksOf("datum-form")) {
      expect(!read(name).includes(sentinel), `${name} carries ${what} (${sentinel}); the renderer has no builder modes`);
    }
    const chunks = chunksOf("datum-builder").filter((name) => read(name).includes(sentinel));
    expect(chunks.length === 1, `exactly one datum-builder-*.js chunk should carry ${what} (${sentinel}); found ${chunks.length}`);
    for (const name of chunks) {
      expect(sizeKb(name) <= budget, `${name} is ${sizeKb(name).toFixed(1)} KB, over ${what}'s ${budget} KB budget; its chunk has taken in more than the mode`);
    }
    expect(read("datum-builder.iife.js").includes(sentinel), `datum-builder.iife.js should carry ${what} inline`);
  }
  // The two modes stay apart: a page with one side on fetches only that side.
  for (const name of chunksOf("datum-builder").filter((chunk) => read(chunk).includes(PDF_MODE))) {
    expect(!read(name).includes(JOURNEY_MODE), `${name} carries both builder modes; each is a chunk of its own`);
  }
  expect(!builder.includes(PIPELINE), "datum-builder.js (with its core chunk) carries the PDF render pipeline statically; since the PDF mode is a chunk it is a lazy chunk the mode and Preview PDF share");
  const pipelineChunks = chunksOf("datum-builder").filter((name) => read(name).includes(PIPELINE));
  expect(pipelineChunks.length === 1, `exactly one datum-builder-*.js chunk should carry the PDF render pipeline; found ${pipelineChunks.length}`);
  for (const name of pipelineChunks) {
    expect(sizeKb(name) <= PIPELINE_CHUNK_BUDGET_KB, `${name} is ${sizeKb(name).toFixed(1)} KB, over the builder PDF pipeline chunk's ${PIPELINE_CHUNK_BUDGET_KB} KB budget`);
  }
}
