// The builder's Header & footer and Variables panels as lazy chunks. The
// shell (default-builder-element.ts) keeps their strip items and the bare elements in its side
// column; each panel's body (builder-chrome-panel.ts, builder-variables-panel.ts) comes from its
// loader (chrome-panel-loader.ts, variables-panel-loader.ts) the first time the panel opens, or
// at connect for a panel remembered open. Neither is in the builder's module nor ever in the
// renderer's. Each sentinel is markup only that panel's module writes. The classic script
// (datum-builder.iife.js) carries both inline, like every other builder chunk.

const CHROME_PANEL = "data-chrome-more"; // builder-chrome-panel.ts: the panel's ⋯ menu button
const VARIABLES_PANEL = "data-variables-syntax"; // builder-variables-panel.ts: the syntax note's hook

// Chunk budgets: measured on the build that split them out: 30,483 B (29.8 KB) and
// 16,568 B (16.2 KB), given about 6% (rounded up to a whole KB).
const CHUNK_BUDGETS_KB = [
  [/^datum-builder-builder-chrome-panel-.+\.js$/, 32],
  [/^datum-builder-builder-variables-panel-.+\.js$/, 18]
];

// datum-builder.js (with its core chunk) is held to the gzip gate in check-bundles.mjs.

export default function guard({ entryText, files, read, chunksOf, expect, sizeKb }) {
  const builder = entryText("datum-builder.js");
  const form = entryText("datum-form.js");
  for (const [label, sentinel] of [
    ["Header & footer panel", CHROME_PANEL],
    ["Variables panel", VARIABLES_PANEL]
  ]) {
    expect(!builder.includes(sentinel), `datum-builder.js (with its core chunk) carries the ${label}; it belongs in a lazy chunk`);
    expect(!form.includes(sentinel), `datum-form.js (with its core chunk) carries the builder's ${label}`);
    const carriers = chunksOf("datum-builder").filter((name) => name.endsWith(".js") && read(name).includes(sentinel));
    expect(carriers.length === 1, `exactly one datum-builder-*.js chunk should carry the ${label}; found ${carriers.length}`);
    expect(
      chunksOf("datum-form").filter((name) => name.endsWith(".js") && read(name).includes(sentinel)).length === 0,
      `a datum-form-*.js chunk carries the builder's ${label}`
    );
  }
  for (const [pattern, limit] of CHUNK_BUDGETS_KB) {
    const named = files.filter((name) => pattern.test(name));
    expect(named.length === 1, `expected one chunk matching ${pattern}; found ${named.length}`);
    for (const name of named) {
      expect(sizeKb(name) <= limit, `${name} is over its ${limit} KB budget; the lazy panel has grown`);
    }
  }
}
