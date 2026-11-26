// The builder's Print workspace as a lazy chunk. The shell (default-builder-element.ts)
// keeps the workspace's tab, its host, the loader (builder/print/print-loader.ts) and the feed; the
// surface, its settings model, the sheet with its break estimate, the samples and the words
// (builder/print/*) come from the loader the first time the author opens Print. Neither the
// builder's entry nor the renderer's may carry them. The sentinel is markup only the surface writes:
// the sheet's host attribute.

const PRINT_SURFACE = "data-print-sheet"; // builder/print/print-surface.ts: the sheet's host

// Chunk budget, in KB: the measure rounded up to a whole KB, plus 6 KB of room for growth.
export const CHUNK_BUDGETS_KB = [
  // Measured: 73,947 B (72.2 KB), rounded up 73 KB, plus 6 KB: 79 KB.
  [/^datum-builder-print-surface-.+\.js$/, 79]
];

// No `budgets` export for datum-builder.js: the base budget stands.

export default function guard({ entryText, files, read, chunksOf, expect, sizeKb }) {
  const builder = entryText("datum-builder.js");
  const form = entryText("datum-form.js");
  expect(!builder.includes(PRINT_SURFACE), `datum-builder.js (with its core chunk) carries the Print workspace (${PRINT_SURFACE}); it belongs in its lazy chunk (print-loader.ts)`);
  expect(!form.includes(PRINT_SURFACE), "datum-form.js (with its core chunk) carries the builder's Print workspace");
  const carriers = chunksOf("datum-builder").filter((name) => name.endsWith(".js") && read(name).includes(PRINT_SURFACE));
  expect(carriers.length === 1, `exactly one datum-builder-*.js chunk should carry the Print workspace (${PRINT_SURFACE}); found ${carriers.length}${carriers.length ? ` (${carriers.join(", ")})` : ""}`);
  expect(
    chunksOf("datum-form").filter((name) => name.endsWith(".js") && read(name).includes(PRINT_SURFACE)).length === 0,
    "a datum-form-*.js chunk carries the builder's Print workspace"
  );
  for (const [pattern, limit] of CHUNK_BUDGETS_KB) {
    const named = files.filter((name) => pattern.test(name));
    expect(named.length === 1, `expected one chunk matching ${pattern}; found ${named.length}`);
    for (const name of named) {
      expect(sizeKb(name) <= limit, `${name} is ${sizeKb(name).toFixed(1)} KB, over its ${limit} KB budget; the lazy Print workspace has grown`);
    }
  }
}
