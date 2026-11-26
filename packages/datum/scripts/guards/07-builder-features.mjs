// The builder's `features` list. The model (builder-features.ts) is a few
// hundred bytes of pure parsing that the shell, its wrapper element and the bundle's exports all
// read synchronously: it belongs in datum-builder.js, in no lazy chunk, and never in the
// renderer. The parts a list can leave out are the lazy chunks (the PDF and Journeys modes, the Header & footer and Variables panels, the Logic, Data,
// Languages, overview, palette, JSON and Try it chunks). That nothing in
// the entry reaches those chunks by value is NOT asserted here: guards 05 (the PDF and journey
// modes) and 06 (the Header & footer and Variables panels) carry the must-not-contain checks for
// the entry. This guard only pins where the model lives. Each sentinel is a message only the
// model (or its callers) spells.
//
// No budget moves here: the model added about 3 KB to datum-builder.js, inside the 5 KB the
// other guards left, and no code left it.

const MODEL = "ignored: not in features"; // builder-features.ts builderSides(), the warning for pdf / journeys the list omits
const UNKNOWN = "unknown feature"; // builder-features.ts parseBuilderFeatures(), the warning for a word that names nothing

export default function guard({ entryText, read, chunksOf, expect }) {
  const builder = entryText("datum-builder.js");
  const form = entryText("datum-form.js");
  for (const sentinel of [MODEL, UNKNOWN]) {
    expect(builder.includes(sentinel), `datum-builder.js (with its core chunk) should carry the features model (${sentinel}); the shell and its element read it synchronously`);
    expect(!form.includes(sentinel), `datum-form.js (with its core chunk) carries the builder's features model (${sentinel}); the renderer has its own list (form-features.ts)`);
    for (const name of chunksOf("datum-form")) {
      expect(!read(name).includes(sentinel), `${name} carries the builder's features model (${sentinel})`);
    }
    // Eager: a lazy chunk holding it would make the first parse wait on a fetch, or load twice.
    const lazy = chunksOf("datum-builder").filter((name) => name.endsWith(".js") && read(name).includes(sentinel));
    expect(lazy.length === 0, `a datum-builder-*.js chunk carries the features model (${sentinel}): ${lazy.join(", ")}; it must stay in the entry`);
    expect(read("datum-builder.iife.js").includes(sentinel), `datum-builder.iife.js should carry the features model (${sentinel}) inline`);
  }
}
