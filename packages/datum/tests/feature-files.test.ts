import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error plain .mjs scripts without typings
import { computeFeatureFiles, filesOf, readFeatureTokens } from "../scripts/feature-files.mjs";
// @ts-expect-error plain .mjs scripts without typings
import guard from "../scripts/guards/11-feature-files.mjs";
// @ts-expect-error plain .mjs scripts without typings
import agentGuard, { CHUNK_BUDGETS_KB } from "../scripts/guards/15-agent.mjs";
// @ts-expect-error plain .mjs scripts without typings
import { CORE_CHUNK, bundleReaders } from "../scripts/guards/lib/loader.mjs";

/**
 * The feature -> files manifest: attribution of a build's lazy files to
 * features, on a fake dist so the rules are pinned without a build.
 */
const tokens = { form: ["journeys", "pdf", "signing"], builder: ["logic", "try-it", "pdf"] };
const made: string[] = [];

function fakeDist(files: Record<string, string>): string {
  const dist = mkdtempSync(join(tmpdir(), "feature-files-"));
  made.push(dist);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dist, name, ".."), { recursive: true });
    writeFileSync(join(dist, name), text);
  }
  return dist;
}

afterEach(() => {
  for (const dist of made.splice(0)) {
    rmSync(dist, { recursive: true, force: true });
  }
});

const BASE = {
  "datum-form.js": 'export{};const a=()=>import("./datum-form-webauthn-AAAAAAAA.js");',
  "datum-form.iife.js": "(function(){})();",
  "datum-form-webauthn-AAAAAAAA.js": 'import{X}from"./datum-form.js";export const m="No passkey or security key is registered to sign with.";',
  "datum-builder.js": 'export{};const l=()=>go("./datum-builder-logic-surface-BBBBBBBB.js");const t=()=>go("./datum-builder-try-it-CCCCCCCC.js");',
  "datum-builder.iife.js": "(function(){})();",
  "datum-builder-logic-surface-BBBBBBBB.js": 'import"./datum-builder-surface-sheet-DDDDDDDD.js";export const a=1;',
  "datum-builder-try-it-CCCCCCCC.js": 'import{s}from"./datum-builder-surface-sheet-DDDDDDDD.js";import"./datum-builder-only-try-FFFFFFFF.js";export const a=2;',
  "datum-builder-only-try-FFFFFFFF.js": "export const b=3;",
  "datum-builder-surface-sheet-DDDDDDDD.js": "export const s=1;",
  "datum-wasm.js": "export const createWasmValidationHost=1;"
};

describe("computeFeatureFiles", () => {
  it("names a chunk's feature from its name or its sentinel, and lists nothing the entries own", () => {
    const manifest = computeFeatureFiles(fakeDist(BASE), { tokens });
    expect(manifest.features.webauthn.files).toEqual(["datum-form-webauthn-AAAAAAAA.js"]);
    expect(manifest.features.logic.files).toEqual(["datum-builder-logic-surface-BBBBBBBB.js"]);
    expect(manifest.features.wasm.files).toEqual(["datum-wasm.js"]);
    expect(manifest.unattributed).toEqual([]);
    const listed = Object.values(manifest.features).flatMap((feature) => (feature as { files: string[] }).files);
    expect(listed.filter((file) => /^datum-(form|builder)(\.iife)?\.js$/.test(file))).toEqual([]);
  });

  it("gives a chunk only one feature's files import to that feature, and a shared one to core", () => {
    const manifest = computeFeatureFiles(fakeDist(BASE), { tokens });
    expect(manifest.features["try-it"].files).toEqual(["datum-builder-only-try-FFFFFFFF.js", "datum-builder-try-it-CCCCCCCC.js"]);
    expect(manifest.core.map((entry: { file: string }) => entry.file)).toContain("datum-builder-surface-sheet-DDDDDDDD.js");
    expect(manifest.core.find((entry: { file: string }) => entry.file.includes("surface-sheet")).note).toMatch(/shared by logic and try-it/);
  });

  it("demotes a feature's chunk that core code imports statically", () => {
    const dist = fakeDist({ ...BASE, "datum-builder.js": `${BASE["datum-builder.js"]}import"./datum-builder-logic-surface-BBBBBBBB.js";` });
    const manifest = computeFeatureFiles(dist, { tokens });
    expect(manifest.features.logic.files).toEqual([]);
    expect(manifest.core.find((entry: { file: string }) => entry.file.includes("logic-surface")).note).toMatch(/statically imported by datum-builder\.js/);
  });

  it("reports a chunk nothing imports as unattributed, and sums bytes with gzip", () => {
    const manifest = computeFeatureFiles(fakeDist({ ...BASE, "datum-builder-orphan-EEEEEEEE.js": "export const o=1;" }), { tokens });
    expect(manifest.unattributed).toEqual(["datum-builder-orphan-EEEEEEEE.js"]);
    expect(manifest.features.wasm.bytes).toBe(BASE["datum-wasm.js"].length);
    expect(manifest.features.wasm.gzipBytes).toBeGreaterThan(0);
  });

  it("resolves the renderer's tokens to the files of their alias", () => {
    const manifest = computeFeatureFiles(fakeDist(BASE), { tokens });
    expect(manifest.features.signing.aliasOf).toBe("webauthn");
    expect(filesOf(manifest, "signing")).toEqual(["datum-form-webauthn-AAAAAAAA.js"]);
    expect(filesOf(manifest, "no-such-token")).toBeUndefined();
  });

  it("gives the agent token one chunk per bundle, by name or by its bundle's sentinel, as bundle both", () => {
    const real = readFeatureTokens();
    expect(real.form).toContain("agent");
    expect(real.builder).toContain("agent");
    const dist = fakeDist({
      ...BASE,
      "datum-form.js": `${BASE["datum-form.js"]}const g=()=>go("./datum-form-agent-AAAAAAAA.js");`,
      "datum-builder.js": `${BASE["datum-builder.js"]}const h=()=>go("./datum-builder-agent-BBBBBBBB.js");`,
      "datum-form-agent-AAAAAAAA.js": 'export const t={name:"describe_form",hint:"call describe_builder first"};',
      "datum-builder-agent-BBBBBBBB.js": 'export const t={name:"describe_builder",hint:"call describe_form first"};'
    });
    const manifest = computeFeatureFiles(dist, { tokens: real });
    expect(manifest.features.agent.files).toEqual(["datum-builder-agent-BBBBBBBB.js", "datum-form-agent-AAAAAAAA.js"]);
    expect(manifest.features.agent.bundle).toBe("both");
    expect(manifest.unattributed).toEqual([]);
    // A chunk under another name is still the agent's when it carries its bundle's sentinel: each
    // bundle's own (describe_form for the form, describe_builder for the builder), and only its own:
    // a form chunk that spells describe_builder (the registrar's hints do) is not the builder's.
    const renamed = fakeDist({
      ...BASE,
      "datum-form.js": `${BASE["datum-form.js"]}const g=()=>go("./datum-form-tools-CCCCCCCC.js");const k=()=>go("./datum-form-misc-GGGGGGGG.js");`,
      "datum-form-tools-CCCCCCCC.js": 'export const t="describe_form";',
      "datum-form-misc-GGGGGGGG.js": 'export const t="describe_builder";',
      "datum-builder.js": `${BASE["datum-builder.js"]}const h=()=>go("./datum-builder-tools-EEEEEEEE.js");`,
      "datum-builder-tools-EEEEEEEE.js": 'export const t={name:"describe_builder"};'
    });
    const renamedManifest = computeFeatureFiles(renamed, { tokens: real });
    expect(renamedManifest.features.agent.files).toEqual(["datum-builder-tools-EEEEEEEE.js", "datum-form-tools-CCCCCCCC.js"]);
    expect(renamedManifest.features.agent.bundle).toBe("both");
  });

  it("claims the builder's three agentpart body chunks for the agent token by name", () => {
    const real = readFeatureTokens();
    const dist = fakeDist({
      ...BASE,
      "datum-form.js": `${BASE["datum-form.js"]}const g=()=>go("./datum-form-agent-AAAAAAAA.js");`,
      "datum-builder.js": `${BASE["datum-builder.js"]}const h=()=>go("./datum-builder-agent-BBBBBBBB.js");`,
      "datum-form-agent-AAAAAAAA.js": 'export const t={name:"describe_form"};',
      "datum-builder-agent-BBBBBBBB.js":
        'export const t={name:"describe_builder"};const a=()=>go("./datum-builder-agentpart-try-GGGGGGGG.js");const b=()=>go("./datum-builder-agentpart-languages-HHHHHHHH.js");const c=()=>go("./datum-builder-agentpart-documents-IIIIIIII.js");',
      // A body carries no catalogue sentinel: the name alone claims it.
      "datum-builder-agentpart-try-GGGGGGGG.js": 'import"./datum-builder-agent-BBBBBBBB.js";export const a="try-it-busy";',
      "datum-builder-agentpart-languages-HHHHHHHH.js": 'import"./datum-builder-agent-BBBBBBBB.js";export const a="source-locale-needed";',
      "datum-builder-agentpart-documents-IIIIIIII.js": 'import"./datum-builder-agent-BBBBBBBB.js";export const a="document-not-open";'
    });
    const manifest = computeFeatureFiles(dist, { tokens: real });
    expect(manifest.features.agent.files).toEqual([
      "datum-builder-agent-BBBBBBBB.js",
      "datum-builder-agentpart-documents-IIIIIIII.js",
      "datum-builder-agentpart-languages-HHHHHHHH.js",
      "datum-builder-agentpart-try-GGGGGGGG.js",
      "datum-form-agent-AAAAAAAA.js"
    ]);
    expect(manifest.features.agent.bundle).toBe("both");
    expect(manifest.features["try-it"].files).not.toContain("datum-builder-agentpart-try-GGGGGGGG.js");
    expect(manifest.unattributed).toEqual([]);
  });

  it("takes the build's core and runtime chunks as core, and reads the core chunk as an importer like an entry", () => {
    const dist = fakeDist({
      ...BASE,
      "datum-builder.js": `${BASE["datum-builder.js"]}import"./datum-builder-core-GGGGGGGG.js";`,
      "datum-builder-core-GGGGGGGG.js": 'import"./datum-builder-rolldown-runtime-HHHHHHHH.js";const e=()=>go("./datum-builder-theme-elements-IIIIIIII.js");const l=()=>go("./datum-builder-logic-surface-BBBBBBBB.js");export const c=1;',
      "datum-builder-rolldown-runtime-HHHHHHHH.js": "export const r=1;",
      "datum-builder-theme-elements-IIIIIIII.js": "export const t=1;"
    });
    const manifest = computeFeatureFiles(dist, { tokens });
    const note = (file: string) => manifest.core.find((entry: { file: string }) => entry.file === file)?.note;
    expect(note("datum-builder-core-GGGGGGGG.js")).toMatch(/imports it statically on load/);
    expect(note("datum-builder-rolldown-runtime-HHHHHHHH.js")).toMatch(/runtime helpers/);
    // A lazy chunk only the core chunk imports follows rule 2, from the core file.
    expect(note("datum-builder-theme-elements-IIIIIIII.js")).toMatch(/imported by core code \(datum-builder-core-GGGGGGGG\.js\)/);
    // A feature's chunk the core chunk imports by a lazy call stays the feature's (the loader in core is the point of it).
    expect(manifest.features.logic.files).toEqual(["datum-builder-logic-surface-BBBBBBBB.js"]);
    expect(manifest.unattributed).toEqual([]);
    const listed = Object.values(manifest.features).flatMap((feature) => (feature as { files: string[] }).files);
    expect(listed.filter((file) => CORE_CHUNK.test(file) || /rolldown-runtime/.test(file))).toEqual([]);
  });

  it("demotes a feature's chunk the core chunk imports statically", () => {
    const dist = fakeDist({
      ...BASE,
      "datum-builder.js": `${BASE["datum-builder.js"]}import"./datum-builder-core-GGGGGGGG.js";`,
      "datum-builder-core-GGGGGGGG.js": 'import"./datum-builder-logic-surface-BBBBBBBB.js";export const c=1;'
    });
    const manifest = computeFeatureFiles(dist, { tokens });
    expect(manifest.features.logic.files).toEqual([]);
    expect(manifest.core.find((entry: { file: string }) => entry.file.includes("logic-surface")).note).toMatch(/statically imported by datum-builder-core-GGGGGGGG\.js/);
  });

  it("reads the real token lists, which the manifest names one by one", () => {
    const real = readFeatureTokens();
    expect(real.form).toContain("journeys");
    expect(real.builder).toContain("header-footer");
    const manifest = computeFeatureFiles(fakeDist(BASE), { tokens: real });
    for (const token of [...real.form, ...real.builder, "pdf-pages", "wasm", "webauthn", "validate-url"]) {
      expect(manifest.features[token], token).toBeDefined();
    }
  });
});

describe("the feature-files guard", () => {
  const run = (dist: string): string[] => {
    const problems: string[] = [];
    guard({ dist, expect: (condition: boolean, message: string) => condition || problems.push(message) });
    return problems;
  };

  // A build with a lazy chunk (or standalone file) for every token the guard requires.
  const LAZY = [
    ["form", "pdf-service"],
    ["form", "server-validator"],
    ["builder", "journey-diagnostics"],
    ["builder", "data-surface"],
    ["builder", "languages-surface"],
    ["builder", "print-surface"],
    // The agent tools: one chunk per bundle.
    ["form", "agent"],
    ["builder", "agent"],
    ["builder", "agentpart-try"],
    ["builder", "agentpart-languages"],
    ["builder", "agentpart-documents"]
  ];
  const full = (): Record<string, string> => {
    const refs = LAZY.map(([bundle, name], index) => `go("./datum-${bundle}-${name}-${String(index).repeat(8)}.js");`);
    const files: Record<string, string> = { ...BASE };
    files["datum-form.js"] = `${BASE["datum-form.js"]}${refs.filter((_ref, index) => LAZY[index]?.[0] === "form").join("")}`;
    files["datum-builder.js"] = `${BASE["datum-builder.js"]}${refs.filter((_ref, index) => LAZY[index]?.[0] === "builder").join("")}`;
    LAZY.forEach(([bundle, name], index) => {
      files[`datum-${bundle}-${name}-${String(index).repeat(8)}.js`] = `export const x${index}=1;`;
    });
    files["datum-pdf-pages.js"] = "export const p=1;";
    return files;
  };

  it("passes a build whose lazy files are all explained and every lazy token lists a file", () => {
    expect(run(fakeDist(full())).filter((problem) => !/token .* is missing/.test(problem))).toEqual([]);
  });

  it("fails a build where a lazy token lists no file", () => {
    const files = full();
    delete files["datum-pdf-pages.js"];
    const problems = run(fakeDist(files)).join("\n");
    expect(problems).toMatch(/lazy token pdf-pages lists no file/);
    expect(problems).not.toMatch(/lazy token wasm lists no file/);
  });

  it("fails a build with zero lazy chunks", () => {
    const problems = run(fakeDist({ "datum-form.js": "export{};", "datum-builder.js": "export{};" })).join("\n");
    for (const token of ["pdf", "journeys", "webauthn", "validate-url", "try-it", "wasm", "logic", "data", "languages", "print", "agent"]) {
      expect(problems, token).toMatch(new RegExp(`lazy token ${token} lists no file`));
    }
  });

  it("fails a build with a lazy file no rule explains", () => {
    expect(run(fakeDist({ ...BASE, "datum-builder-orphan-EEEEEEEE.js": "export const o=1;" })).join("\n")).toMatch(/orphan-EEEEEEEE/);
  });
});

describe("the agent guard (15)", () => {
  // check-bundles.mjs's context over a fake dist.
  const run = (dist: string): string[] => {
    const problems: string[] = [];
    const files = readdirSync(dist).filter((name) => name.endsWith(".js"));
    const read = (name: string): string => readFileSync(join(dist, name), "utf8");
    const expectFn = (condition: boolean, message: string): boolean | number => condition || problems.push(message);
    agentGuard({
      dist,
      files,
      read,
      // A bundle's lazy chunks: never its own core chunk (check-bundles.mjs's chunksOf).
      chunksOf: (base: string) => files.filter((name) => name.startsWith(`${base}-`) && !CORE_CHUNK.test(name)),
      expect: expectFn,
      sizeKb: (name: string) => statSync(join(dist, name)).size / 1024,
      ...bundleReaders({ dist, files, read, expect: expectFn })
    });
    return problems;
  };

  // The registrar's handle hints spell both sentinels, so every agent chunk carries both.
  const HINT = 'const hint=(k)=>k==="form"?"describe_form":"describe_builder";';
  const FORM_AGENT = `${HINT}export const tools=["describe_form","set_answers"];`;
  const BUILDER_AGENT = `${HINT}export const tools=["describe_builder","list_component_types"];`;
  const good = (): Record<string, string> => ({
    "datum-form.js": 'export{};go("./datum-form-agent-AAAAAAAA.js");',
    "datum-form-agent-AAAAAAAA.js": FORM_AGENT,
    "datum-form.iife.js": `(function(){${FORM_AGENT}})();`,
    "datum-builder.js": 'export{};go("./datum-builder-agent-BBBBBBBB.js");',
    "datum-builder-agent-BBBBBBBB.js": BUILDER_AGENT,
    // The three body chunks, each told by a sentinel only it spells.
    "datum-builder-agentpart-try-GGGGGGGG.js": 'import"./datum-builder.js";export const a="try-it-busy";',
    "datum-builder-agentpart-languages-HHHHHHHH.js": 'import"./datum-builder.js";export const a="source-locale-needed";',
    "datum-builder-agentpart-documents-IIIIIIII.js": 'import"./datum-builder.js";export const a="document-not-open";',
    "datum-builder.iife.js": `(function(){${BUILDER_AGENT}"try-it-busy","source-locale-needed","document-not-open"})();`
  });

  it("passes one agent chunk per bundle carrying its own catalogue", () => {
    expect(run(fakeDist(good()))).toEqual([]);
  });

  it("reads an entry with its core chunk: the tools in a core chunk are an entry carrying them, and the core chunk is no lazy chunk", () => {
    const withCore = (entry: string, core: string, text: string): Record<string, string> => ({
      ...good(),
      [`datum-${entry}.js`]: `${good()[`datum-${entry}.js`]}import"./datum-${entry}-core-JJJJJJJJ.js";`,
      [`datum-${entry}-core-JJJJJJJJ.js`]: core,
      [`datum-${entry}.iife.js`]: text
    });
    const clean = withCore("builder", "export const c=1;", good()["datum-builder.iife.js"] ?? "");
    expect(run(fakeDist(clean))).toEqual([]);
    const leaky = run(fakeDist({ ...clean, "datum-builder-core-JJJJJJJJ.js": `export const t={name:"list_component_types"};` })).join("\n");
    expect(leaky).toMatch(/datum-builder\.js \(with its core chunk\) carries the builder's agent catalogue/);
    // The core chunk is not counted among the lazy chunks that must carry the catalogue exactly once.
    expect(leaky).not.toMatch(/exactly one datum-builder-\*\.js chunk should carry the builder's agent catalogue/);
  });

  it("fails a builder agent chunk with the registrar but no builder catalogue (the sentinels alone pass it)", () => {
    const problems = run(
      fakeDist({ ...good(), "datum-builder-agent-BBBBBBBB.js": `import"./datum-builder.js";${HINT}`, "datum-builder.iife.js": `(function(){${HINT}})();` })
    ).join("\n");
    expect(problems).toMatch(/exactly one datum-builder-\*\.js chunk should carry the builder's agent catalogue \("list_component_types"\); found 0/);
    expect(problems).toMatch(/datum-builder\.iife\.js should carry its agent catalogue \("list_component_types"\)/);
    expect(problems).not.toMatch(/describe_builder/);
  });

  it("fails a form agent chunk with the registrar but no renderer catalogue", () => {
    const problems = run(fakeDist({ ...good(), "datum-form-agent-AAAAAAAA.js": HINT, "datum-form.iife.js": `(function(){${HINT}})();` })).join("\n");
    expect(problems).toMatch(/exactly one datum-form-\*\.js chunk should carry the renderer's agent catalogue \("set_answers"\); found 0/);
    expect(problems).toMatch(/datum-form\.iife\.js should carry its agent catalogue \("set_answers"\)/);
  });

  it("holds the body chunks to their budgets (padded from the numbers in force, so a budget change never turns it red)", () => {
    // The agent tools' stop lines are temporary: read each limit from the guard, never spell it here.
    const limitOf = (name: string): number => (CHUNK_BUDGETS_KB as Array<[RegExp, number]>).find(([pattern]) => pattern.test(name))![1];
    const over = (name: string, sentinel: string): string => {
      const limit = limitOf(name);
      const pad = `/*${"x".repeat((limit + 1) * 1024)}*/`;
      return run(fakeDist({ ...good(), [name]: `export const a="${sentinel}";${pad}` })).join("\n");
    };
    for (const [name, sentinel] of [
      ["datum-builder-agentpart-try-GGGGGGGG.js", "try-it-busy"],
      ["datum-builder-agentpart-languages-HHHHHHHH.js", "source-locale-needed"],
      ["datum-builder-agentpart-documents-IIIIIIII.js", "document-not-open"]
    ] as Array<[string, string]>) {
      expect(over(name, sentinel)).toContain(`${name} is ${limitOf(name) + 1}.0 KB, over its ${limitOf(name)} KB budget`);
    }
    expect(run(fakeDist(good()))).toEqual([]);
  });

  it("fails a body sentinel missing, doubled, in an entry, in the form bundle or outside the classic script", () => {
    const missing = run(fakeDist({ ...good(), "datum-builder-agentpart-documents-IIIIIIII.js": "export const a=1;" })).join("\n");
    expect(missing).toMatch(/datum-builder-agentpart-documents-\*\.js, should carry "document-not-open"; found 0/);
    const doubled = run(fakeDist({ ...good(), "datum-builder-misc-JJJJJJJJ.js": 'export const t="source-locale-needed";' })).join("\n");
    expect(doubled).toMatch(/should carry "source-locale-needed"; found 2/);
    const inMain = run(fakeDist({ ...good(), "datum-builder-agent-BBBBBBBB.js": `${BUILDER_AGENT}export const r="try-it-busy";` })).join("\n");
    expect(inMain).toMatch(/should carry "try-it-busy"; found 2/);
    const entry = run(fakeDist({ ...good(), "datum-builder.js": 'export{};go("./datum-builder-agent-BBBBBBBB.js");const x="document-not-open";' })).join("\n");
    expect(entry).toMatch(/datum-builder\.js \(with its core chunk\) carries the datum-builder-agentpart-documents body/);
    const form = run(fakeDist({ ...good(), "datum-form-misc-KKKKKKKK.js": 'export const t="source-locale-needed";' })).join("\n");
    expect(form).toMatch(/datum-form-misc-KKKKKKKK\.js carries the builder's datum-builder-agentpart-languages body/);
    const classic = run(fakeDist({ ...good(), "datum-builder.iife.js": `(function(){${BUILDER_AGENT}})();` })).join("\n");
    expect(classic).toMatch(/datum-builder\.iife\.js should carry the datum-builder-agentpart-try body/);
  });

  it("fails the catalogue's first tool or list_component_types in a body chunk", () => {
    const problems = run(fakeDist({ ...good(), "datum-builder-agentpart-try-GGGGGGGG.js": 'export const a="try-it-busy";const t="list_component_types";' })).join("\n");
    expect(problems).toMatch(/datum-builder-agentpart-try-GGGGGGGG\.js carries "list_component_types"; only the builder's main agent chunk/);
  });

  it("fails a surface, mode or Try it chunk imported statically by the main agent chunk, and guard 14's sentinels in any agent chunk", () => {
    const imported = run(
      fakeDist({
        ...good(),
        "datum-builder-agent-BBBBBBBB.js": `import"./datum-builder-try-it-CCCCCCCC.js";import{a}from"./datum-builder-languages-surface-LLLLLLLL.js";${BUILDER_AGENT}`,
        "datum-builder-try-it-CCCCCCCC.js": "export const x=1;",
        "datum-builder-languages-surface-LLLLLLLL.js": "export const a=1;"
      })
    ).join("\n");
    expect(imported).toMatch(/imports datum-builder-try-it-CCCCCCCC\.js statically/);
    expect(imported).toMatch(/imports datum-builder-languages-surface-LLLLLLLL\.js statically/);
    const lazy = run(fakeDist({ ...good(), "datum-builder-agent-BBBBBBBB.js": `${BUILDER_AGENT}const t=()=>import("./datum-builder-try-it-CCCCCCCC.js");`, "datum-builder-try-it-CCCCCCCC.js": "export const x=1;" })).join("\n");
    expect(lazy).not.toMatch(/statically/);
    const leaked = run(fakeDist({ ...good(), "datum-builder-agentpart-try-GGGGGGGG.js": 'export const a="try-it-busy";const b="cm-lineNumbers";' })).join("\n");
    expect(leaked).toMatch(/datum-builder-agentpart-try-GGGGGGGG\.js carries "cm-lineNumbers", guard 14's sentinel/);
    const bodyToBody = run(fakeDist({ ...good(), "datum-builder-agentpart-try-GGGGGGGG.js": 'import"./datum-builder-agentpart-documents-IIIIIIII.js";export const a="try-it-busy";' })).join("\n");
    expect(bodyToBody).toMatch(/the three bodies stand apart/);
  });

  it("fails the planner or the languages model imported statically by the main agent chunk", () => {
    const planner = run(
      fakeDist({
        ...good(),
        "datum-builder-agent-BBBBBBBB.js": `import"./datum-builder-data-model-plan-PPPPPPPP.js";import{m}from"./datum-builder-languages-model-MMMMMMMM.js";${BUILDER_AGENT}`,
        "datum-builder-data-model-plan-PPPPPPPP.js": "export const p=1;",
        "datum-builder-languages-model-MMMMMMMM.js": "export const m=1;"
      })
    ).join("\n");
    expect(planner).toMatch(/imports datum-builder-data-model-plan-PPPPPPPP\.js statically/);
    expect(planner).toMatch(/imports datum-builder-languages-model-MMMMMMMM\.js statically/);
  });

  it("fails an entry that spells its own bundle's catalogue tool", () => {
    const builder = run(fakeDist({ ...good(), "datum-builder.js": 'export{};go("./datum-builder-agent-BBBBBBBB.js");const zz="list_component_types";' })).join("\n");
    expect(builder).toMatch(/datum-builder\.js \(with its core chunk\) carries the builder's agent catalogue \("list_component_types"\)/);
    const form = run(fakeDist({ ...good(), "datum-form.js": 'export{};go("./datum-form-agent-AAAAAAAA.js");const zz="set_answers";' })).join("\n");
    expect(form).toMatch(/datum-form\.js \(with its core chunk\) carries the renderer's agent catalogue \("set_answers"\)/);
  });

  it("fails datum-form.js carrying the agent-off refusal code", () => {
    const problems = run(fakeDist({ ...good(), "datum-form.js": 'export{};const c="agent-off";' }));
    expect(problems.join("\n")).toMatch(/datum-form\.js \(with its core chunk\) carries the agent-off refusal code/);
  });

  it("fails datum-builder.js carrying the agent-off refusal code", () => {
    const problems = run(fakeDist({ ...good(), "datum-builder.js": 'export{};const c="agent-off";' }));
    expect(problems.join("\n")).toMatch(/datum-builder\.js \(with its core chunk\) carries the agent-off refusal code/);
  });

  it("lets the form agent chunk carry agent-off (the refusal belongs there)", () => {
    expect(run(fakeDist({ ...good(), "datum-form-agent-AAAAAAAA.js": `${FORM_AGENT}export const c="agent-off";` }))).toEqual([]);
  });

  it("fails a catalogue in two chunks of one bundle, or in the other bundle", () => {
    const twice = run(fakeDist({ ...good(), "datum-builder-misc-CCCCCCCC.js": 'export const t="list_component_types";' })).join("\n");
    expect(twice).toMatch(/builder's agent catalogue \("list_component_types"\); found 2/);
    const crossed = run(fakeDist({ ...good(), "datum-builder-agent-BBBBBBBB.js": `${BUILDER_AGENT}export const r="set_answers";` })).join("\n");
    expect(crossed).toMatch(/datum-builder-agent-BBBBBBBB\.js carries the renderer's agent catalogue/);
  });
});
