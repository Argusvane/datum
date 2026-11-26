import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import "../src/builder.js";
import { BUILDER_FONTS_STYLESHEET, BUILDER_FONT_ATTRIBUTE, loadBuilderFonts } from "../src/builder-fonts.js";
import { sampleDefinition, until } from "./helpers.js";

/** The builder's own faces (the studio look): Geist, self-hosted. */
describe("the builder's fonts", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    for (const link of document.querySelectorAll(`link[${BUILDER_FONT_ATTRIBUTE}]`)) link.remove();
  });

  it("ships Geist and Geist Mono with their licence and one @font-face sheet", () => {
    const dir = `${resolve(dirname(fileURLToPath(import.meta.url)), "../fonts/builder-fonts")}/`;
    for (const file of ["geist-variable.woff2", "geist-mono-variable.woff2", "OFL-geist.txt", "builder-fonts.css"]) {
      expect(existsSync(`${dir}${file}`), file).toBe(true);
    }
    const css = readFileSync(`${dir}builder-fonts.css`, "utf8");
    expect(css).toContain('font-family: "Geist";');
    expect(css).toContain('font-family: "Geist Mono";');
    expect(css).toContain("font-display: swap;");
    expect(readFileSync(`${dir}OFL-geist.txt`, "utf8")).toContain("SIL Open Font License");
  });

  it("links the sheet once, beside the bundle", () => {
    const first = loadBuilderFonts(document, "https://cdn.example/datum/datum-builder.js");
    const again = loadBuilderFonts(document, "https://cdn.example/datum/datum-builder.js");
    expect(first).toHaveLength(1);
    expect(again[0]).toBe(first[0]);
    expect(first[0]!.href).toBe(`https://cdn.example/datum/${BUILDER_FONTS_STYLESHEET}`);
  });

  it("is linked by <datum-form-builder load-fonts> and not without it", async () => {
    const plain = document.createElement("datum-form-builder") as HTMLElement & { definition?: unknown; controller?: unknown };
    plain.definition = sampleDefinition();
    document.body.append(plain);
    await until(() => plain.controller);
    expect([...document.querySelectorAll(`link[${BUILDER_FONT_ATTRIBUTE}]`)].some((link) => link.getAttribute(BUILDER_FONT_ATTRIBUTE)!.endsWith(BUILDER_FONTS_STYLESHEET))).toBe(false);
    const loading = document.createElement("datum-form-builder") as HTMLElement & { definition?: unknown; controller?: unknown };
    loading.setAttribute("load-fonts", "");
    loading.definition = sampleDefinition();
    document.body.append(loading);
    await until(() => [...document.querySelectorAll(`link[${BUILDER_FONT_ATTRIBUTE}]`)].some((link) => link.getAttribute(BUILDER_FONT_ATTRIBUTE)!.endsWith(BUILDER_FONTS_STYLESHEET)));
  });
});
