// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BUILTIN_FRAME_IDS, frameClassName, frameOptions, isKnownFrame, type FormFrameDefinition } from "../form-engine/render/live/datum/frames.js";
import { datumFrameOptions, type DatumBindingOptions } from "../form-engine/render/live/datum/options.js";
import { DATUM_STYLES } from "../form-engine/render/live/datum/css.js";
import { readFormChromeConfiguration, readFrameSetting, resolveFrame } from "../form-engine/core/schema/form-chrome.js";
import { definitionOf, drawDatum, unmountAll } from "./live-datum-parts-kit.js";
import { hideConstructedSheets } from "./setup/constructed-sheets.js";

afterEach(unmountAll);

// The frames' css is read back as the <style> text the renderer places where a root takes no constructed sheets.
let restoreSheets = (): void => undefined;
beforeEach(() => {
  restoreSheets = hideConstructedSheets();
});
afterEach(() => {
  restoreSheets();
});

const FRAMES: Record<string, FormFrameDefinition> = {
  paper: { label: { default: "Card", locales: { fr: "Carte" } }, css: ".datum-form--frame-paper { border-width: 2px; }" },
  notepad: { label: "Notepad", css: ".datum-form--frame-notepad { border: 2px dashed currentColor; }" }
};

/** The form element a root chrome block (`frame`) is drawn in by the Datum binding with `options`. */
async function formFor(frame: unknown, options: DatumBindingOptions = {}): Promise<HTMLFormElement> {
  const m = await drawDatum(definitionOf([{ id: "a", type: "text", configuration: { label: "A" } }], {}, frame === undefined ? {} : { chrome: { frame } }), options, { featureOptions: {} });
  return m.root.querySelector("form") as HTMLFormElement;
}

describe("form frames — choosing one", () => {
  it("reads a frame id in either form, and refuses anything else", () => {
    expect(readFrameSetting("paper")).toEqual({ id: "paper" });
    expect(readFrameSetting({ id: "paper", fixed: true })).toEqual({ id: "paper", fixed: true });
    expect(readFrameSetting({ id: "paper", fixed: "yes" })).toEqual({ id: "paper" });
    expect(readFrameSetting("Paper Sheet")).toBeUndefined();
    expect(readFrameSetting({ fixed: true })).toBeUndefined();
    expect(readFrameSetting(3)).toBeUndefined();
  });

  it("lets the host's frame stand in when the author picked none, yield when they did, and win when fixed", () => {
    expect(resolveFrame(undefined, undefined)).toBe("seamless");
    expect(resolveFrame({ frame: "paper" }, undefined)).toBe("paper");
    expect(resolveFrame({ frame: "paper" }, { frame: "outlined" })).toBe("outlined");
    expect(resolveFrame({ frame: { id: "paper", fixed: true } }, { frame: "outlined" })).toBe("paper");
    expect(resolveFrame({ frame: { id: "seamless", fixed: true } }, { frame: "paper" })).toBe("seamless");
    expect(resolveFrame({ header: [], formChrome: "exclude" }, { frame: "paper" })).toBe("paper");
  });

  it("keeps the author's frame as a plain id, alone or with parts", () => {
    expect(readFormChromeConfiguration({ chrome: { frame: "paper" } })).toEqual({ frame: "paper" });
    expect(readFormChromeConfiguration({ chrome: { frame: { id: "paper", fixed: true } } })).toEqual({ frame: "paper" });
    expect(readFormChromeConfiguration({ chrome: { frame: "no spaces" } })).toBeUndefined();
    expect(readFormChromeConfiguration({ chrome: { frame: "outlined", header: [{ id: "title", type: "form-title" }] } })).toEqual({
      frame: "outlined",
      header: [{ id: "title", type: "form-title" }]
    });
  });
});

describe("form frames — markup and styles", () => {
  it("adds nothing for seamless or no frame, and the class and data-frame otherwise", async () => {
    const bare = await formFor(undefined);
    expect(bare.className).not.toContain("datum-form--frame");
    expect(bare.hasAttribute("data-frame")).toBe(false);
    expect((await formFor("seamless")).className).not.toContain("datum-form--frame");
    const paper = await formFor("paper");
    expect(paper.classList.contains("datum-form--frame-paper")).toBe(true);
    expect(paper.getAttribute("data-frame")).toBe("paper");
    expect(frameClassName("paper")).toBe("datum-form--frame-paper");
  });

  it("draws a frame a binding adds, with its css adopted beside the sheet", async () => {
    const notepad = await formFor("notepad", { frame: FRAMES });
    expect(notepad.classList.contains("datum-form--frame-notepad")).toBe(true);
    const css = Array.from((notepad.getRootNode() as ShadowRoot).querySelectorAll("style[data-datum-live]")).map((style) => style.textContent ?? "").join("\n");
    expect(css).toContain(".datum-form--frame-notepad { border: 2px dashed currentColor; }");
    expect(css).toContain(".datum-form--frame-paper { border-width: 2px; }");
  });

  it("draws a frame nothing defines in the default frame, and says so once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ticket = await formFor("ticket");
    expect(ticket.className).not.toContain("datum-form--frame");
    expect(ticket.hasAttribute("data-frame")).toBe(false);
    const warned = warn.mock.calls.filter((call) => String(call[0]).includes('"ticket"'));
    expect(warned).toHaveLength(1);
    // A frame the binding does define is drawn as asked and warns of nothing.
    warn.mockClear();
    expect((await formFor("notepad", { frame: FRAMES })).classList.contains("datum-form--frame-notepad")).toBe(true);
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("default frame"))).toEqual([]);
  });

  it("draws the built-ins from tokens in the Datum stylesheet", () => {
    expect(DATUM_STYLES).toContain(".datum-form--frame-outlined, .datum-form--frame-paper {");
    expect(DATUM_STYLES).toContain("padding: var(--spacing-frame-padding, 24px);");
    expect(DATUM_STYLES).toContain("border: 1px solid var(--color-frame-border, var(--color-border, #a9bbcb));");
    expect(DATUM_STYLES).toContain("border-radius: var(--radius-frame, 10px);");
    expect(DATUM_STYLES).toContain("background: var(--color-frame-surface, var(--color-surface, #fff));");
    expect(DATUM_STYLES).toContain("box-shadow: var(--shadow-frame,");
    expect(DATUM_STYLES).not.toContain(".datum-form--frame-seamless");
  });
});

describe("form frames — what a picker offers", () => {
  it("lists the built-ins first, then the binding's own, a binding relabelling a built-in in place", () => {
    expect(BUILTIN_FRAME_IDS).toEqual(["seamless", "outlined", "paper"]);
    expect(frameOptions(undefined)).toEqual([
      { id: "seamless", label: "Seamless (no frame)" },
      { id: "outlined", label: "Outlined" },
      { id: "paper", label: "Paper" }
    ]);
    expect(frameOptions(FRAMES, "fr-CA")).toEqual([
      { id: "seamless", label: "Seamless (no frame)" },
      { id: "outlined", label: "Outlined" },
      { id: "paper", label: "Carte" },
      { id: "notepad", label: "Notepad" }
    ]);
    expect(frameOptions({})).toHaveLength(3);
    expect(datumFrameOptions({ frames: FRAMES }).map((option) => option.id)).toEqual(["seamless", "outlined", "paper", "notepad"]);
  });

  it("knows a built-in and a binding's frame, not a stranger", () => {
    expect(isKnownFrame("seamless")).toBe(true);
    expect(isKnownFrame("paper")).toBe(true);
    expect(isKnownFrame("notepad", FRAMES)).toBe(true);
    expect(isKnownFrame("notepad", undefined)).toBe(false);
  });
});

describe("frame helpers: the engine entry and the live layer", () => {
  it("are still exported by the engine root", async () => {
    const root = await import("../form-engine/index.js");
    for (const name of ["frameOptions", "frameClassName", "BUILTIN_FRAMES", "BUILTIN_FRAME_IDS", "isKnownFrame"]) {
      expect(root, name).toHaveProperty(name);
    }
  });

  it("keep frames.ts free of lit, since the builder's inspector and the entry import it", () => {
    const source = readFileSync(new NodeURL("../form-engine/render/live/datum/frames.ts", import.meta.url), "utf8");
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((specifier) => /^lit(\/|$)|@lit\//.test(specifier))).toEqual([]);
    expect(specifiers.filter((specifier) => specifier.startsWith(".") && !/\/(core)\//.test(specifier))).toEqual([]);
  });
});
