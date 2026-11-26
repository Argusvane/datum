import { describe, expect, it } from "vitest";

import {
  FORM_CHROME_PART_TYPES,
  hasLanguageSwitcher,
  readFormChromeConfiguration,
  readFormChromePart,
  readFormChromeParts,
  readHostChromeConfiguration,
  resolveRegionParts
} from "../form-engine/core/schema/form-chrome.js";

describe("form chrome schema — reading the form's authored block", () => {
  it("reads nothing from a root without chrome, an empty block, or a block that is not an object", () => {
    expect(readFormChromeConfiguration(undefined)).toBeUndefined();
    expect(readFormChromeConfiguration({})).toBeUndefined();
    expect(readFormChromeConfiguration({ chrome: {} })).toBeUndefined();
    expect(readFormChromeConfiguration({ chrome: { header: [], footer: "no" } })).toBeUndefined();
    expect(readFormChromeConfiguration({ chrome: [] })).toBeUndefined();
  });

  it("keeps only the regions with parts, and only the host-facing part fields", () => {
    const read = readFormChromeConfiguration({
      chrome: {
        header: [{ id: "title", type: "form-title", level: 2, align: "center", extra: 1 }],
        footer: [],
        formChrome: "exclude",
        formLanguageSwitcher: false
      }
    });
    expect(read).toEqual({ header: [{ id: "title", type: "form-title", level: 2, align: "center" }] });
  });

  it("normalises every part type, dropping what it cannot draw", () => {
    const parts = readFormChromeParts([
      { id: "lang", type: "language-switcher", label: "Language", hideLabel: true, align: "start" },
      { id: "logo", type: "image", src: "/logo.svg", alt: "Acme", href: "/", width: 120.7, height: -3 },
      { id: "nosrc", type: "image", alt: "no src" },
      { id: "hi", type: "heading", text: "Hi", level: 4 },
      { id: "nan", type: "heading", text: 42 },
      { id: "note", type: "text", text: "T" },
      { id: "empty", type: "text" },
      { id: "blurb", type: "html", html: "<p>x</p>" },
      { id: "title", type: "form-title" },
      { id: "desc", type: "form-description", align: "sideways" },
      { id: "row", type: "group", justify: "end", verticalAlign: "start", parts: [{ id: "in", type: "text", text: "in" }, { id: "gone", type: "nope" }] },
      { id: "bare", type: "group", parts: "none" },
      { id: "x", type: "unknown", text: "x" },
      "text",
      null
    ]);
    expect(parts).toEqual([
      { id: "lang", type: "language-switcher", label: "Language", hideLabel: true, align: "start" },
      { id: "logo", type: "image", src: "/logo.svg", alt: "Acme", href: "/", width: 120 },
      { id: "hi", type: "heading", text: "Hi" },
      { id: "note", type: "text", text: "T" },
      { id: "blurb", type: "html", html: "<p>x</p>" },
      { id: "title", type: "form-title" },
      { id: "desc", type: "form-description" },
      { id: "row", type: "group", justify: "end", verticalAlign: "start", parts: [{ id: "in", type: "text", text: "in" }] },
      { id: "bare", type: "group", parts: [] }
    ]);
    expect(readFormChromePart({ id: "h", type: "html" })).toBeUndefined();
    expect(readFormChromePart(undefined)).toBeUndefined();
  });

  it("reads no authored part without a safe id, since its translations would have no key", () => {
    expect(readFormChromePart({ type: "text", text: "x" })).toBeUndefined();
    expect(readFormChromePart({ id: "", type: "text", text: "x" })).toBeUndefined();
    expect(readFormChromePart({ id: "__proto__", type: "text", text: "x" })).toBeUndefined();
    expect(readFormChromePart({ id: "constructor", type: "form-title" })).toBeUndefined();
    // Inside a group the same holds for each part.
    expect(readFormChromePart({ id: "row", type: "group", parts: [{ type: "text", text: "no id" }, { id: "ok", type: "text", text: "id" }] })).toEqual({
      id: "row",
      type: "group",
      parts: [{ id: "ok", type: "text", text: "id" }]
    });
  });

  it("reads an authored text only as a string, and a host's as a string or a LocalizedText marked host", () => {
    expect(readFormChromePart({ id: "t", type: "text", text: { default: "T", locales: { fr: "T-fr" } } })).toBeUndefined();
    expect(readHostChromeConfiguration({ header: [{ type: "text", text: { default: "T", locales: { fr: "T-fr", de: 3 } } }, { type: "text", text: "plain" }] })).toEqual({
      header: [
        { type: "text", text: { default: "T", locales: { fr: "T-fr" } }, host: true },
        { type: "text", text: "plain", host: true }
      ]
    });
  });

  it("names every part type once", () => {
    expect(new Set(FORM_CHROME_PART_TYPES).size).toBe(FORM_CHROME_PART_TYPES.length);
    for (const type of FORM_CHROME_PART_TYPES) {
      const id = `part_${type}`;
      const sample =
        type === "image"
          ? { id, type, src: "/x.png" }
          : type === "heading" || type === "text"
            ? { id, type, text: "x" }
            : type === "html"
              ? { id, type, html: "<p>x</p>" }
              : type === "group"
                ? { id, type, parts: [] }
                : { id, type };
      expect(readFormChromePart(sample)?.type).toBe(type);
    }
  });
});

describe("form chrome schema — merging the host's parts with the form's", () => {
  // The form's parts are authored (an id each); the host's are marked, with no id of their own.
  const switcher = { id: "lang", type: "language-switcher" as const };
  const hostSwitcher = { type: "language-switcher" as const, host: true as const };
  const hostText = (text: string) => ({ type: "text" as const, text, host: true as const });
  const form = {
    header: [{ id: "welcome", type: "heading" as const, text: "Welcome" }, switcher],
    footer: [{ id: "contact", type: "text" as const, text: "Contact" }]
  };

  it("draws the host's parts alone when the form authored none", () => {
    expect(resolveRegionParts("header", { header: [hostSwitcher] }, undefined)).toEqual([hostSwitcher]);
    expect(resolveRegionParts("footer", { header: [hostSwitcher] }, undefined)).toEqual([]);
  });

  it("puts the form's parts first and the host's after, per region", () => {
    const host = { header: [hostText("host")], footer: [hostText("host-foot")] };
    expect(resolveRegionParts("header", host, form)).toEqual([...form.header, ...host.header]);
    expect(resolveRegionParts("footer", host, form)).toEqual([...form.footer, ...host.footer]);
  });

  it("drops the host's switcher when the author placed one, carrying the host's wording over as the host's", () => {
    const host = { header: [{ ...hostSwitcher, label: "Lang", hideLabel: true }] };
    expect(resolveRegionParts("header", host, form)).toEqual([form.header[0], { ...switcher, label: "Lang", hideLabel: true, host: true }]);
    // The author's slot in a group is found too, and a host switcher in a group is dropped from it.
    const grouped = { header: [{ id: "row", type: "group" as const, parts: [{ id: "logo", type: "text" as const, text: "logo" }, switcher] }] };
    const hostGrouped = { header: [{ type: "group" as const, host: true as const, parts: [{ ...hostSwitcher, label: "Lang" }] }, hostText("after")] };
    expect(resolveRegionParts("header", hostGrouped, grouped)).toEqual([
      { id: "row", type: "group", parts: [{ id: "logo", type: "text", text: "logo" }, { ...switcher, label: "Lang", host: true }] },
      hostText("after")
    ]);
  });

  it("keeps the author's own wording when the host gives the switcher no label", () => {
    const withLabel = { header: [{ id: "lang", type: "language-switcher" as const, label: "Language" }] };
    const [kept] = resolveRegionParts("header", { header: [{ ...hostSwitcher, hideLabel: true }] }, withLabel);
    expect(kept).toEqual({ id: "lang", type: "language-switcher", label: "Language", hideLabel: true });
  });

  it("drops the author's switcher instead when the host says formLanguageSwitcher: false", () => {
    expect(resolveRegionParts("header", { footer: [hostSwitcher], formLanguageSwitcher: false }, form)).toEqual([form.header[0]]);
    expect(resolveRegionParts("footer", { footer: [hostSwitcher], formLanguageSwitcher: false }, form)).toEqual([...form.footer, hostSwitcher]);
  });

  it("draws the host's parts alone under formChrome: exclude", () => {
    expect(resolveRegionParts("header", { header: [hostSwitcher], formChrome: "exclude" }, form)).toEqual([hostSwitcher]);
    expect(resolveRegionParts("footer", { formChrome: "exclude" }, form)).toEqual([]);
  });
});

describe("form chrome schema — the language switcher part", () => {
  it("finds a language switcher among a region's parts", () => {
    expect(hasLanguageSwitcher([{ type: "language-switcher" }])).toBe(true);
    expect(hasLanguageSwitcher([{ type: "heading", text: "Acme" }])).toBe(false);
    expect(hasLanguageSwitcher(undefined)).toBe(false);
  });
});
