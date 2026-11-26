// The Move to dialog's UI (drag-drop/move-ui.ts) is a lazy chunk, like the other builder
// surfaces (guards 05 to 07). A form builder with no Move button pressed should not pay for its
// popover markup and key handling, so `data-move-position` (an attribute only that UI writes)
// must be absent from the entry datum-builder.js and present in exactly one
// datum-builder-*.js chunk. Exercised by the final build only; no budget moves here.

const SENTINEL = "data-move-position";

export default function guard({ entryText, read, chunksOf, expect }) {
  const entry = entryText("datum-builder.js");
  expect(!entry.includes(SENTINEL), `datum-builder.js (with its core chunk) carries the Move to UI (${SENTINEL}); move-ui.ts must be reached by dynamic import alone`);
  const holding = chunksOf("datum-builder").filter((name) => name.endsWith(".js") && read(name).includes(SENTINEL));
  expect(holding.length === 1, `exactly one datum-builder-*.js chunk should carry the Move to UI (${SENTINEL}); found ${holding.length}${holding.length ? ` (${holding.join(", ")})` : ""}`);
}
