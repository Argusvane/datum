import { describe, expect, it } from "vitest";

import { applyImport, previewImport } from "../form-engine/builder/languages/exchange.js";
import type { ExchangeText } from "../form-engine/builder/languages/exchange.js";
import { addressOf, isSourceHash, isStale, sourceHash, STALE_SOURCE, writeTranslation, writeTranslationEntry, writeTranslations } from "../form-engine/core/localization/translations.js";

const label = (id: string, def: string, texts: Record<string, string> = {}, sources: Record<string, string> = {}): ExchangeText => ({
  address: { kind: "components", owner: id, path: ["label"] },
  default: def,
  group: "Fields",
  where: id,
  texts,
  sources
});

const run = (name: string, body: string, texts: ExchangeText[] = [label("a", "Hi")], declared: string[] = ["en", "fr"], mode: "fill" | "replace" = "replace") =>
  previewImport({ name, text: body }, texts, declared, { mode, defaultLocale: "en" });

describe("a JSON file with many language columns", () => {
  it("is read in linear time and offers the first hundred new languages", () => {
    const row: Record<string, string> = { kind: "components", key: "a", path: "label" };
    for (let i = 0; i < 50_000; i += 1) {
      row[`fr-${i.toString(36).padStart(4, "0")}`] = "x";
    }
    const started = Date.now();
    const result = run("many.json", JSON.stringify({ texts: [row] }), [label("a", "Hi")], ["en"]);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.newLocales).toHaveLength(100);
    expect(result.problems.filter((problem) => problem.code === "tooManyLocales").length).toBeGreaterThan(0);
  }, 30000);

  it("counts only new languages against the cap", () => {
    const row: Record<string, string> = { kind: "components", key: "a", path: "label", fr: "Salut", "NOT A LANGUAGE": "x" };
    for (let i = 0; i < 100; i += 1) {
      row[`xx-${i.toString(36).padStart(3, "0")}`] = "x";
    }
    const result = run("cap.json", JSON.stringify({ texts: [row] }), [label("a", "Hi")], ["en", "fr"]);
    expect(result.newLocales).toHaveLength(100);
    expect(result.problems.filter((problem) => problem.code === "tooManyLocales")).toEqual([]);
    expect(result.rows.find((r) => r.locale === "fr")?.newLocale).toBe(false);
  });

  it("reads one tag spelled three ways as one new language", () => {
    const row = { kind: "components", key: "a", path: "label", "fr-CA": "A", FR_ca: "B", "fr-ca": "C" };
    const result = run("case.json", JSON.stringify({ texts: [row] }), [label("a", "Hi")], ["en"]);
    expect(result.newLocales).toEqual(["fr-CA"]);
    expect(result.rows).toHaveLength(1);
  });
});

describe("cells are trimmed", () => {
  const csv = (cell: string): string => `kind,key,path,lang:fr\r\ncomponents,a,label,"${cell}"\r\n`;

  it("a whitespace-only CSV cell is no cell", () => {
    const result = run("blank.csv", csv("   "));
    expect(result.rows).toEqual([]);
    expect(applyImport(result, { addLocales: [], mode: "replace" }).edits).toEqual([]);
  });

  it("does not overwrite a real translation in Replace mode", () => {
    const result = run("blank.csv", csv(" "), [label("a", "Hi", { fr: "Salut" })]);
    expect(applyImport(result, { addLocales: [], mode: "replace" }).edits).toEqual([]);
  });

  it("imports the text without the space around it", () => {
    const result = run("pad.csv", csv("  Salut  "));
    expect(result.rows[0]?.text).toBe("Salut");
    expect(result.rows[0]?.status).toBe("new");
  });

  it("reads a padded copy of the stored text as unchanged", () => {
    const result = run("pad.csv", csv(" Salut "), [label("a", "Hi", { fr: "Salut" })]);
    expect(result.rows[0]?.status).toBe("unchanged");
  });

  it("trims JSON cells the same way", () => {
    const result = run("pad.json", JSON.stringify({ texts: [{ kind: "components", key: "a", path: "label", fr: "  \t " }] }));
    expect(result.rows).toEqual([]);
  });
});

describe("the map does not hold a blank wording, and keeps what the author wrote", () => {
  const at = addressOf.component("a", "label");

  it("writeTranslation treats blank as removal and keeps the space of a real wording", () => {
    const written = writeTranslation(undefined, "fr", at, "  Salut ", "Hi");
    expect(written.fr?.components?.a?.label).toEqual({ text: "  Salut ", source: sourceHash("Hi") });
    expect(writeTranslation(written, "fr", at, "   ", "Hi")).toEqual({});
  });

  it("writeTranslations does the same", () => {
    const { translations } = writeTranslations(undefined, [{ locale: "fr", address: at, text: "   ", defaultText: "Hi" }]);
    expect(translations).toEqual({});
    const kept = writeTranslations(undefined, [{ locale: "fr", address: at, text: " Salut ", defaultText: "Hi" }]).translations;
    expect(kept.fr?.components?.a?.label?.text).toBe(" Salut ");
  });

  it("an import still words every cell without its outer space", () => {
    const result = run("padded.csv", "kind,key,path,lang:fr\r\ncomponents,a,label,  Salut \r\n");
    expect(result.rows[0]?.text).toBe("Salut");
  });
});

describe("an imported source fingerprint", () => {
  it("is stored only when it has the shape of a hash", () => {
    const long = "z".repeat(500_000);
    const body = JSON.stringify({ texts: [{ kind: "components", key: "a", path: "label", source: long, fr: "Salut" }] });
    const result = run("long.json", body);
    expect(result.rows[0]?.source).toBeUndefined();
    expect(applyImport(result, { addLocales: [], mode: "replace" }).edits.every((edit) => edit.source === undefined)).toBe(true);
  });

  it("keeps a real hash that no longer matches, so the entry stays flagged", () => {
    const stale = sourceHash("Old");
    const result = run("stale.csv", `kind,key,path,source,lang:fr\r\ncomponents,a,label,${stale},Salut\r\n`);
    expect(result.rows[0]?.stale).toBe(true);
    expect(applyImport(result, { addLocales: [], mode: "replace" }).edits[0]?.source).toBe(stale);
  });

  it("is checked by the writers too", () => {
    const at = addressOf.component("a", "label");
    expect(isSourceHash(sourceHash("Hi"))).toBe(true);
    expect(isSourceHash("z".repeat(100))).toBe(false);
    expect(isSourceHash("")).toBe(false);
    // A source that is no fingerprint never enters the map, and never reads as the current
    // default's either: the entry is kept as a stale marker, so the author is asked.
    const edited = writeTranslations(undefined, [{ locale: "fr", address: at, text: "Salut", defaultText: "Hi", source: "z".repeat(100_000) }]).translations;
    const marker = edited.fr?.components?.a?.label;
    expect(marker?.text).toBe("Salut");
    expect(marker?.source).toBe(STALE_SOURCE);
    expect(isStale(marker as { text: string; source: string }, "Hi")).toBe(true);
    const entry = writeTranslationEntry(undefined, "fr", at, { text: "Salut", source: "z".repeat(100_000) }).fr?.components?.a?.label;
    expect(entry).toEqual({ text: "Salut", source: STALE_SOURCE });
    // A marker already stored is written again as it is.
    expect(writeTranslationEntry({ fr: { components: { a: { label: entry } } } } as never, "fr", at, { text: "Salut", source: STALE_SOURCE }).fr?.components?.a?.label).toEqual(entry);
    // No source given: the entry answers the current default.
    expect(writeTranslations(undefined, [{ locale: "fr", address: at, text: "Salut", defaultText: "Hi" }]).translations.fr?.components?.a?.label?.source).toBe(sourceHash("Hi"));
    expect(writeTranslationEntry(undefined, "fr", at, { text: "Salut", source: "abc12" }).fr?.components?.a?.label?.source).toBe("abc12");
  });
});

describe("line breaks in an imported file", () => {
  it("reads CRLF in an XLIFF target as LF", () => {
    const xliff = `<?xml version="1.0"?><xliff version="2.0" srcLang="en" trgLang="fr" xmlns="urn:oasis:names:tc:xliff:document:2.0"><file id="f"><unit id="components/a/label"><segment><source>A\nB</source><target>C\r\nD\rE</target></segment></unit></file></xliff>`;
    const result = run("crlf.xlf", xliff, [label("a", "A\nB")]);
    expect(result.rows[0]?.text).toBe("C\nD\nE");
    expect(result.rows[0]?.stale).toBe(false);
  });

  it("keeps a numeric reference to a carriage return", () => {
    const xliff = `<?xml version="1.0"?><xliff version="2.0" srcLang="en" trgLang="fr" xmlns="urn:oasis:names:tc:xliff:document:2.0"><file id="f"><unit id="components/a/label"><segment><source>A</source><target>x&#13;y</target></segment></unit></file></xliff>`;
    expect(run("cr.xlf", xliff, [label("a", "A")]).rows[0]?.text).toBe("x\ry");
  });

  it("reads CRLF inside a quoted CSV cell as LF", () => {
    const result = run("crlf.csv", 'kind,key,path,lang:fr\r\ncomponents,a,label,"one\r\ntwo"\r\n');
    expect(result.rows[0]?.text).toBe("one\ntwo");
  });
});
