// The agent tools (WebMCP): one lazy chunk per bundle, datum-form-agent-*.js and
// datum-builder-agent-*.js, fetched only when a page lists the opt-in `agent` feature (never in
// `all`, never in the absent-attribute default). Each bundle's chunk carries the registrar, the
// binding and its own catalogue only: the form's (src/agent.ts) the
// renderer catalogue, the builder's (src/builder/agent.ts) the builder's twenty-four tools and its
// element host. So the renderer catalogue's own tool, set_answers, is in no datum-builder-* file
// at all, entry, chunk or classic script (`<datum-form>` inside the builder bundle has no agent
// tools: src/agent-loader.ts), and the builder catalogue's own tool, list_component_types, is in no
// datum-form-* file. Neither is a bundle sentinel; those are below.
//
// The bundle sentinels are each catalogue's first tool name:
// describe_form for the form, describe_builder for the builder. Both name the agent layer, not one
// catalogue: the registrar's handle hints spell describe_form and describe_builder, so both chunks
// carry both, and each sentinel is counted among its own bundle's files only. So a
// sentinel proves the agent layer is there, never that the bundle's catalogue is: a chunk holding
// the registrar alone (a stub, say) passes it. The catalogues are therefore held by a
// tool name only one catalogue spells, both ways. set_answers (agent/form/ only) is in exactly one
// datum-form-* chunk and inline in datum-form.iife.js, and in no datum-builder-* file;
// list_component_types (agent/builder/ only; the registrar and the session texts never spell it)
// is in exactly one datum-builder-* chunk and inline in datum-builder.iife.js, and in no
// datum-form-* file, entry, chunks and classic script alike.
//
// The builder's agent chunk is one main chunk and three lazy body chunks,
// datum-builder-agentpart-{try,languages,documents}-*.js (agent/builder/agentpart-<area>.ts:
// vite names a chunk after its entry module, and try-it-* would collide with the Try it chunk). Each body
// is told by a sentinel only it spells: try-it-busy (the Try it body's refusal code), source-locale-needed
// (Languages) and document-not-open (Documents). A body sentinel is in exactly one datum-builder-* file,
// that body, and inline in datum-builder.iife.js (the classic script cannot split), and in neither entry
// nor any datum-form-* file. describe_builder and list_component_types stay in the main chunk alone (a
// body never carries the catalogue), set_answers in no datum-builder-* file at all. The main chunk's
// static import list names no surface, mode, editor or Try it chunk (a tool never fetches a chunk it
// did not lazy-load by name: they are reached through the host's loaders), and no chunk of the agent
// layer carries guard 14's sentinels (the Tests panel and CodeMirror stay behind their own loaders).
// check-bundles.mjs holds the source-map rules (the planner, the languages model and agent/ sources
// out of the entries); this guard holds the text and the budgets.
//
// No `budgets` export: the entry budgets live in check-bundles.mjs's base and guards 04, 05, 06,
// 08 and 12, which hold the same numbers.

const SENTINELS = {
  "datum-form": "describe_form", // engine/form-engine/agent/form/tools.ts: the renderer catalogue's first tool
  "datum-builder": "describe_builder" // engine/form-engine/agent/builder/reads.ts: the builder catalogue's first tool
};
const RENDERER_CATALOGUE = "set_answers"; // engine/form-engine/agent/form/tools.ts only: never in a datum-builder-* file
const BUILDER_CATALOGUE = "list_component_types"; // engine/form-engine/agent/builder/ only: never in a datum-form-* file
// Each bundle's own catalogue, which its agent chunk (and classic script) must carry.
const CATALOGUES = { "datum-form": RENDERER_CATALOGUE, "datum-builder": BUILDER_CATALOGUE };

// The builder's body chunks, each told by one string only its body spells (agent/builder/agentpart-<area>.ts).
const BODY_SENTINELS = {
  "datum-builder-agentpart-try": "try-it-busy", // agentpart-try.ts: the Try it body's refusal code
  "datum-builder-agentpart-languages": "source-locale-needed", // agentpart-languages.ts: the Languages body's refusal code
  "datum-builder-agentpart-documents": "document-not-open" // agentpart-documents.ts: the Documents body's refusal code
};
// Guard 14's sentinels (the Tests panel's Run all, the judge's withheld verdict, CodeMirror): none in any agent chunk.
const TESTS_SENTINELS = ["data-tests-run-all", "expect.withheld", "cm-lineNumbers"];
// The chunks the main agent chunk may not import statically: the surfaces, the modes and their designers, Try it,
// the Tests panel and the formula editor are reached through the host's loaders only.
const MAIN_CHUNK_FORBIDDEN_IMPORTS = [
  "try-it",
  "languages-surface",
  "data-surface",
  "logic-surface",
  "builder-tests-panel",
  "tests-editor",
  "formula-editor",
  "pdf-builder-mode",
  "journey-builder-mode",
  "pdf-designer-chunk",
  "journey-designer",
  // The shared chunks the planner and the languages model live in: the agent reaches them through loadDataModelPlan()
  // and the Languages loader, never by a static import (that would load 25 KB and 28 KB with every agent).
  "data-model-plan",
  "languages-model"
];

// Chunk budgets, in KB: the measure plus 3 KB, rounded up. Exported by name (the runners read `budgets` only)
// so tests/feature-files.test.ts pads a fake chunk from the number in force instead of hard-coding it.
export const CHUNK_BUDGETS_KB = [
  // The renderer's agent chunk: the registrar, the binding, the renderer catalogue and the form's element host; no
  // journey page code (it reads the page through the host's JourneyRenderKit) and no builder code (no agent/builder/
  // source in its map). It also carries the registrar's access gate and accessChanged, the sealed listing row, the
  // agent-off messages, the dispose loop and core/schema/agent-tools-setting.ts (the setting reader; forms import it
  // only from form/tools.ts, so it sits here and not in datum-form.js; the builder entry carries its own copy).
  // Measured 154,707 B (151.1 KB; 50,789 B gzip), plus 3 KB, rounded up. Largest sources: form/tools.ts 70.1 KB,
  // registrar.ts 25.9 KB, form/describe.ts 13.0 KB, src/agent-host.ts 6.7 KB.
  [/^datum-form-agent-.+\.js$/, 155],
  // The builder's main agent chunk: lazy and opt-in, with the bodies split out. The map names agent/builder/ (writes.ts
  // 37.4 KB, reads.ts 24.0 KB, tools.ts 20.9 KB, components.ts 14.8 KB, tests-tools.ts 14.1 KB, checks.ts 13.5 KB,
  // outside-journal.ts 10.6 KB, context.ts 9.3 KB, ui-tools.ts 8.6 KB), registrar.ts (25.8 KB, with the shared gate, the
  // assistants guidance, the author refusal, the history check and dispose), src/builder/agent-host.ts 12.2 KB, and no
  // body, mode, Try it, planner, languages-model or agent/answers source (check-bundles.mjs reads the map). It also
  // carries the managed-path bounds on add_components, replace_form and duplicate_component and the reserved-id wording.
  // Measured 245,452 B (239.7 KB), plus 3 KB, rounded up.
  [/^datum-builder-agent-.+\.js$/, 243],
  // The three body chunks (agent/builder/agentpart-<area>.ts), each loaded on first use of its tools.
  // Try it body: measured 45,509 B (44.4 KB; 16,158 B gzip), budget 48 KB. agentpart-try.ts 21.0 KB, try-fields.ts 13.5 KB,
  // try-settings.ts 3.9 KB, agent/answers/ 5.7 KB.
  [/^datum-builder-agentpart-try-.+\.js$/, 48],
  // Languages body: measured 15,038 B (14.7 KB; 5,903 B gzip), plus 3 KB, rounded up. LanguagesModel is a
  // shared chunk (datum-builder-languages-model-*.js, core in feature-files.json), not counted.
  [/^datum-builder-agentpart-languages-.+\.js$/, 18],
  // Documents body: measured 28,257 B (27.6 KB; 9,518 B gzip), budget 31 KB. agentpart-documents.ts 26.1 KB,
  // documents-support.ts 1.3 KB.
  [/^datum-builder-agentpart-documents-.+\.js$/, 31]
];

export default function guard({ entryText, files, read, chunksOf, expect, sizeKb }) {
  const staticImports = (name) => [...read(name).matchAll(/(?:\bfrom\s*|\bimport\s*)["']\.\/([^"']+)["']/g)].map((match) => match[1]);
  const entries = ["datum-form.js", "datum-builder.js"];
  for (const entry of entries) {
    for (const sentinel of Object.values(SENTINELS)) {
      expect(!entryText(entry).includes(sentinel), `${entry} (with its core chunk) carries the agent tools (${JSON.stringify(sentinel)}); they belong in a lazy chunk`);
    }
  }
  // The author and host switches: the gate and its refusal live in the lazy chunk (the registrar), so
  // the entries hold only the agent-access attribute and its parse and never the agent-off refusal code.
  for (const entry of entries) {
    expect(!entryText(entry).includes("agent-off"), `${entry} (with its core chunk) carries the agent-off refusal code; the access gate and its messages belong in the lazy agent chunk`);
  }
  // Nor does an entry spell its own bundle's catalogue (the source-map rule only catches a name that comes from an agent/ source).
  expect(!entryText("datum-builder.js").includes(BUILDER_CATALOGUE), `datum-builder.js (with its core chunk) carries the builder's agent catalogue (${JSON.stringify(BUILDER_CATALOGUE)}); it belongs in the lazy agent chunk`);
  expect(!entryText("datum-form.js").includes(RENDERER_CATALOGUE), `datum-form.js (with its core chunk) carries the renderer's agent catalogue (${JSON.stringify(RENDERER_CATALOGUE)}); it belongs in the lazy agent chunk`);
  for (const [bundle, sentinel] of Object.entries(SENTINELS)) {
    const carriers = chunksOf(bundle).filter((name) => name.endsWith(".js") && sizeKb(name) > 0 && read(name).includes(sentinel));
    expect(
      carriers.length === 1,
      `exactly one ${bundle}-*.js chunk should carry the agent tools (${JSON.stringify(sentinel)}); found ${carriers.length}${carriers.length ? ` (${carriers.join(", ")})` : ""}`
    );
    // The classic script cannot split: it carries the chunk inline.
    expect(read(`${bundle}.iife.js`).includes(sentinel), `${bundle}.iife.js should carry the agent tools (${JSON.stringify(sentinel)}) inline`);
  }
  // Each bundle's chunk carries its own catalogue (the sentinels above cannot tell it from the
  // registrar's hints) ...
  for (const [bundle, tool] of Object.entries(CATALOGUES)) {
    const carriers = chunksOf(bundle).filter((name) => name.endsWith(".js") && sizeKb(name) > 0 && read(name).includes(tool));
    expect(
      carriers.length === 1,
      `exactly one ${bundle}-*.js chunk should carry the ${bundle === "datum-form" ? "renderer's" : "builder's"} agent catalogue (${JSON.stringify(tool)}); found ${carriers.length}${carriers.length ? ` (${carriers.join(", ")})` : ""}`
    );
    expect(read(`${bundle}.iife.js`).includes(tool), `${bundle}.iife.js should carry its agent catalogue (${JSON.stringify(tool)}) inline`);
  }
  // ... and only its own.
  for (const name of files.filter((file) => file.startsWith("datum-builder") && file.endsWith(".js"))) {
    expect(!read(name).includes(RENDERER_CATALOGUE), `${name} carries the renderer's agent catalogue (${JSON.stringify(RENDERER_CATALOGUE)}); the builder bundle's agent chunk carries the builder's only`);
  }
  for (const name of files.filter((file) => file.startsWith("datum-form") && file.endsWith(".js"))) {
    expect(!read(name).includes(BUILDER_CATALOGUE), `${name} carries the builder's agent catalogue (${JSON.stringify(BUILDER_CATALOGUE)}); the form bundle's agent chunk carries the renderer's only`);
  }
  // The catalogue tools live in the builder's main agent chunk, never in a body chunk.
  for (const tool of [SENTINELS["datum-builder"], BUILDER_CATALOGUE]) {
    for (const name of chunksOf("datum-builder").filter((file) => file.endsWith(".js") && read(file).includes(tool))) {
      expect(/^datum-builder-agent-[^/]+\.js$/.test(name), `${name} carries ${JSON.stringify(tool)}; only the builder's main agent chunk (datum-builder-agent-*.js) does, never a body chunk`);
    }
  }
  // The body chunks: each sentinel in exactly one datum-builder-* file, its own body, inline in the classic script, and nowhere else.
  for (const [body, sentinel] of Object.entries(BODY_SENTINELS)) {
    const carriers = chunksOf("datum-builder").filter((name) => name.endsWith(".js") && sizeKb(name) > 0 && read(name).includes(sentinel));
    expect(
      carriers.length === 1 && carriers[0].startsWith(`${body}-`),
      `exactly one datum-builder-*.js chunk, ${body}-*.js, should carry ${JSON.stringify(sentinel)}; found ${carriers.length}${carriers.length ? ` (${carriers.join(", ")})` : ""}`
    );
    expect(read("datum-builder.iife.js").includes(sentinel), `datum-builder.iife.js should carry the ${body} body (${JSON.stringify(sentinel)}) inline`);
    for (const entry of entries) {
      expect(!entryText(entry).includes(sentinel), `${entry} (with its core chunk) carries the ${body} body (${JSON.stringify(sentinel)}); it belongs in its lazy chunk`);
    }
    for (const name of files.filter((file) => file.startsWith("datum-form") && file.endsWith(".js"))) {
      expect(!read(name).includes(sentinel), `${name} carries the builder's ${body} body (${JSON.stringify(sentinel)}); the form bundle never does`);
    }
  }
  const bodies = chunksOf("datum-builder").filter((name) => name.startsWith("datum-builder-agentpart-") && name.endsWith(".js"));
  const mains = chunksOf("datum-builder").filter((name) => name.startsWith("datum-builder-agent-") && name.endsWith(".js"));
  // Guard 14's sentinels stay out of every agent chunk.
  for (const name of [...mains, ...bodies]) {
    for (const sentinel of TESTS_SENTINELS) {
      expect(!read(name).includes(sentinel), `${name} carries ${JSON.stringify(sentinel)}, guard 14's sentinel: the Tests panel and its editor stay behind their own loaders`);
    }
  }
  // The main chunk imports no surface, mode, editor or Try it chunk statically; a body imports no other body.
  for (const name of mains) {
    for (const target of staticImports(name)) {
      expect(!MAIN_CHUNK_FORBIDDEN_IMPORTS.some((part) => target.includes(`-${part}-`)), `${name} imports ${target} statically; a surface, mode, editor or Try it chunk is reached through its loader, never from the agent chunk`);
      expect(!target.startsWith("datum-builder-agentpart-"), `${name} imports the body chunk ${target} statically; the bodies are loaded on first use`);
    }
  }
  for (const name of bodies) {
    for (const target of staticImports(name)) {
      expect(!target.startsWith("datum-builder-agentpart-"), `${name} imports the body chunk ${target}; the three bodies stand apart`);
    }
  }
  for (const [pattern, limit] of CHUNK_BUDGETS_KB) {
    const named = files.filter((name) => pattern.test(name) && sizeKb(name) > 0);
    expect(named.length === 1, `expected one chunk matching ${pattern}; found ${named.length}`);
    for (const name of named) {
      expect(sizeKb(name) <= limit, `${name} is ${sizeKb(name).toFixed(1)} KB, over its ${limit} KB budget; the agent chunk has grown`);
    }
  }
}
