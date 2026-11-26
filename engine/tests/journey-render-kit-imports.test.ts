import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PRESENTATION_SLOT } from "../form-engine/core/journey/presentation.js";
import { NoopJourneyRenderKit } from "../form-engine/render/core/journey-render-kit.js";
import { EagerJourneyRenderKit } from "../form-engine/render/core/journey-render-kit-eager.js";
import { defaultJourneyRenderKit } from "../form-engine/render/core/journey-render-kit-default.js";
import * as renderIndex from "../form-engine/render/index.js";

// The plain-form render path reaches the journey modules only through the kit, so
// the chunk boundary of the lazy split is clean. Source-level pins: a value import of
// journey-render / presentation in these files would drag them into the entry.

const read = (path: string): string => readFileSync(new URL(`../form-engine/render/${path}`, import.meta.url), "utf8");

/** Every import/export-from statement in a file, as [typeOnly, specifier]. */
function moduleRefs(source: string): Array<{ typeOnly: boolean; from: string }> {
  const refs: Array<{ typeOnly: boolean; from: string }> = [];
  for (const m of source.matchAll(/^(import|export)\s+(type\s+)?([^;]*?)\s+from\s+"([^"]+)";/gms)) {
    // `import { a, type B }` is a value import for the module even when only some names are types.
    refs.push({ typeOnly: m[2] !== undefined, from: m[4] as string });
  }
  return refs;
}

const JOURNEY_MODULES = /(^|\/)(journey-render|presentation)\.js$/;

describe("the journey modules are reached through the kit only", () => {
  for (const file of ["core/runtime-render-bridge.ts", "core/journey-render-kit.ts", "core/journey-render-kit-default.ts", "web-component/form-renderer-element.ts"]) {
    it(`${file} imports journey-render and presentation as types only`, () => {
      const offenders = moduleRefs(read(file)).filter((ref) => JOURNEY_MODULES.test(ref.from) && !ref.typeOnly);
      expect(offenders).toEqual([]);
    });
  }

  it("the live page module is reached by value through the eager kit alone (journeys stay in their chunk)", () => {
    // Every engine module that value-imports render/live/journey-page.ts: the eager kit.
    const root = new URL("../form-engine/", import.meta.url);
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((file) => file.endsWith(".ts"));
    const importers = (pattern: RegExp): string[] =>
      files.filter((file) => moduleRefs(readFileSync(new URL(file, root), "utf8")).some((ref) => pattern.test(ref.from) && !ref.typeOnly)).sort();
    expect(importers(/(^|\/)journey-page\.js$/)).toEqual(["render/core/journey-render-kit-factory.ts"]);
  });

  it("the Check answers list is reached by value through the Check answers kit alone (it is a chunk of its own)", () => {
    const root = new URL("../form-engine/", import.meta.url);
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((file) => file.endsWith(".ts"));
    const importers = (pattern: RegExp): string[] =>
      files.filter((file) => moduleRefs(readFileSync(new URL(file, root), "utf8")).some((ref) => pattern.test(ref.from) && !ref.typeOnly)).sort();
    // The live drawing: the kit (core/) names it as ../live/journey-review.js; nothing in live/ imports it by value.
    expect(importers(/(^|\/)live\/journey-review\.js$/)).toEqual(["render/core/journey-review-kit-eager.ts"]);
    expect(importers(/^\.\/journey-review\.js$/).filter((file) => file.startsWith("render/live/"))).toEqual([]);
    // The list's model: the kit, and the live drawing beside it in the chunk.
    expect(importers(/(^|\/)core\/journey-review\.js$|^\.\/journey-review\.js$/).filter((file) => !file.startsWith("render/live/"))).toEqual(["render/core/journey-review-kit-eager.ts"]);
    expect(importers(/(^|\/)core\/journey-review\.js$/).filter((file) => file.startsWith("render/live/"))).toEqual(["render/live/journey-review.ts"]);
    // The real Check answers kit: the full eager kit alone (the page kit and the page module take one handed in).
    expect(importers(/(^|\/)journey-review-kit-eager\.js$/)).toEqual(["render/core/journey-render-kit-eager.ts", "render/index.ts"]);
    // The answer-as-text module is the print model's and the list's, never the eager print theme's.
    expect(importers(/(^|\/)field-answer\.js$/)).toEqual(["render/core/journey-review.ts", "render/print/model.ts"]);
  });

  it("the kit file imports nothing by value but types (the Noop is its only code)", () => {
    const values = moduleRefs(read("core/journey-render-kit.ts")).filter((ref) => !ref.typeOnly);
    expect(values).toEqual([]);
  });

  it("the bridge's spelling of the presentation slot is the module's", () => {
    expect(read("core/runtime-render-bridge.ts")).toContain(`const PRESENTATION_SLOT = ${JSON.stringify(PRESENTATION_SLOT)};`);
  });

  it("the barrel keeps exporting the modules, the kits and the default-kit slot", () => {
    expect(renderIndex.NoopJourneyRenderKit).toBe(NoopJourneyRenderKit);
    expect(renderIndex.EagerJourneyRenderKit).toBe(EagerJourneyRenderKit);
    expect(typeof renderIndex.buildJourneyMeta).toBe("function");
    expect(renderIndex.defaultJourneyRenderKit).toBe(defaultJourneyRenderKit);
    expect(typeof renderIndex.setDefaultJourneyRenderKit).toBe("function");
  });

  it("no render file falls back to the eager kit: the default is the slot's, Noop unless a host sets it", () => {
    for (const file of ["core/render-orchestrator.ts", "core/runtime-render-bridge.ts"]) {
      const source = read(file);
      expect(source, file).toContain("defaultJourneyRenderKit()");
      expect(source, file).not.toMatch(/journey-render-kit-eager/);
      expect(source, file).not.toContain("?? EagerJourneyRenderKit");
    }
  });
});
