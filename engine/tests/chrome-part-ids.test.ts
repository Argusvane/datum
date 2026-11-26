// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { chromePartIdProblems, chromePartText, readFormChromeConfiguration, readFormChromeParts } from "../form-engine/core/schema/form-chrome.js";
import { definitionOf, drawDatum, unmountAll } from "./live-datum-parts-kit.js";
import { sourceHash } from "../form-engine/core/localization/translations.js";

function nest(depth: number): unknown {
  let part: unknown = { id: "leaf", type: "text", text: "Deep" };
  for (let level = 0; level < depth; level += 1) {
    part = { id: `g${level}`, type: "group", parts: [part] };
  }
  return part;
}

function groupDepth(parts: readonly unknown[] | undefined): number {
  let depth = 0;
  let level = parts;
  while (level && level.length > 0) {
    depth += 1;
    const next = level[0] as { type?: string; parts?: unknown[] };
    level = next.type === "group" ? next.parts : undefined;
  }
  return depth;
}

describe("chrome part ids", () => {
  const french = { fr: { chrome: { x: { text: { text: "Bienvenue", source: sourceHash("Welcome") } } } } };

  it("a part sharing an id with another is drawn without that id's translation", () => {
    const chrome = readFormChromeConfiguration({
      chrome: { header: [{ id: "x", type: "text", text: "Welcome" }], footer: [{ id: "x", type: "text", text: "Privacy notice" }] }
    })!;
    const header = chromePartText(chrome.header![0]!, "text", "fr", { translations: french });
    const footer = chromePartText(chrome.footer![0]!, "text", "fr", { translations: french });
    expect(footer).toBe("Privacy notice");
    expect(header).toBe("Welcome");
  });

  it("a repeated id inside a group counts too", () => {
    const chrome = readFormChromeConfiguration({
      chrome: { header: [{ type: "group", id: "g", parts: [{ id: "x", type: "text", text: "Welcome" }] }], footer: [{ id: "x", type: "text", text: "Privacy notice" }] }
    })!;
    expect(chromePartText(chrome.footer![0]!, "text", "fr", { translations: french })).toBe("Privacy notice");
    const group = chrome.header![0]!;
    expect(group.type === "group" && chromePartText(group.parts[0]!, "text", "fr", { translations: french })).toBe("Welcome");
  });

  it("a record the reader cannot draw still holds its id", () => {
    // The check counts the records as written; the renderer must agree with it.
    const chrome = { header: [{ id: "x", type: "no-such-part" }, { id: "x", type: "text", text: "Welcome" }] };
    expect(chromePartIdProblems({ chrome }).map((problem) => problem.code)).toEqual(["repeated", "repeated"]);
    const read = readFormChromeConfiguration({ chrome })!;
    expect(read.header).toHaveLength(1);
    expect(chromePartText(read.header![0]!, "text", "fr", { translations: french })).toBe("Welcome");
  });

  it("a part that is unique keeps its translation", () => {
    const chrome = readFormChromeConfiguration({ chrome: { header: [{ id: "x", type: "text", text: "Welcome" }] } })!;
    expect(chromePartText(chrome.header![0]!, "text", "fr", { translations: french })).toBe("Bienvenue");
  });

  it("a part with no id, or an unsafe one, is drawn rather than dropped, and never translated", () => {
    const chrome = readFormChromeConfiguration({
      chrome: { header: [{ id: "x", type: "text", text: "Welcome" }, { type: "text", text: "No id" }, { id: "__proto__", type: "text", text: "Unsafe" }, { id: "", type: "text", text: "Blank" }] }
    })!;
    expect(chrome.header!.map((part) => (part.type === "text" ? part.text : ""))).toEqual(["Welcome", "No id", "Unsafe", "Blank"]);
    expect(chrome.header!.slice(1).every((part) => part.id === undefined)).toBe(true);
    expect(chromePartText(chrome.header![1]!, "text", "fr", { translations: french })).toBe("No id");
  });

  it("the strict readers still drop a part with no id (the panel and the agent's writes rely on it)", () => {
    expect(readFormChromeParts([{ type: "text", text: "No id" }])).toEqual([]);
  });

  it("lists the ids that cannot key a translation", () => {
    const problems = chromePartIdProblems({
      chrome: {
        header: [{ id: "a", type: "text", text: "A" }, { type: "text", text: "none" }, { type: "group", id: "g", parts: [{ id: "a", type: "text", text: "A2" }] }],
        footer: [{ id: "constructor", type: "text", text: "U" }, { id: "b", type: "text", text: "B" }]
      }
    });
    expect(problems).toEqual([
      { code: "repeated", region: "header", position: [0], id: "a" },
      { code: "missing", region: "header", position: [1] },
      { code: "repeated", region: "header", position: [2, 0], id: "a" },
      { code: "unsafe", region: "footer", position: [0], id: "constructor" }
    ]);
  });

  it("lists nothing for a clean or a hostile block, and never throws", () => {
    expect(chromePartIdProblems({ chrome: { header: [{ id: "a", type: "text", text: "A" }], footer: [{ id: "b", type: "text", text: "B" }] } })).toEqual([]);
    expect(chromePartIdProblems(undefined)).toEqual([]);
    expect(chromePartIdProblems({ chrome: { header: "x", footer: [null, 3, [], { id: 5, type: "text" }] } }).map((problem) => problem.code)).toEqual(["unsafe"]);
    expect(() => chromePartIdProblems({ chrome: { header: [nest(5000)] } })).not.toThrow();
  });
});

describe("chrome group nesting", () => {
  it("is cut at the depth components may nest", () => {
    const chrome = readFormChromeConfiguration({ chrome: { header: [nest(5000)] } })!;
    expect(groupDepth(chrome.header)).toBe(32);
  });

  it("draws a very deep chain without overflowing the stack", async () => {
    const definition = definitionOf([{ id: "a", type: "text", configuration: { label: "A" } }], {}, { chrome: { header: [nest(5000)] } });
    await expect(drawDatum(definition)).resolves.toBeDefined();
    unmountAll();
  });
});
