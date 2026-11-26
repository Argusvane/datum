import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  applyImport,
  countsFor,
  exportCsv,
  exportJson,
  exportXliff,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_CELL_BYTES,
  MAX_IMPORT_ROWS,
  previewImport,
  promptText,
  textsInScope,
  willApply
} from "../form-engine/builder/languages/exchange.js";
import type { ExchangeHeader, ExchangeText } from "../form-engine/builder/languages/exchange.js";
import { addressOf, listTranslations, sourceHash } from "../form-engine/core/localization/translations.js";
import type { TextAddress } from "../form-engine/core/localization/translations.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";

/**
 * The exchange of the Languages workspace: texts out as JSON, CSV and XLIFF,
 * translations back in with a preview first. The rows come from the canonical fixture, so an
 * export read back is "unchanged" everywhere.
 */

const fixture = JSON.parse(readFileSync(new URL("./fixtures/customer-intake.translations.json", import.meta.url), "utf8")) as FormDefinition;
const HEADER: ExchangeHeader = { form: "customer-intake", defaultLocale: "en", exportedAt: "2026-10-28T00:00:00Z" };
const LOCALES = ["fr-CA", "es"];

type Bag = Record<string, unknown>;

function find(node: ComponentNode, id: string): ComponentNode | undefined {
  if (node.id === id) {
    return node;
  }
  for (const slot of Object.values(node.children ?? {})) {
    for (const child of slot) {
      const found = find(child, id);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

/** The default-language string at an address of the fixture (the workspace's adapter does this from the controller's rows). */
function defaultOf(address: TextAddress): string {
  const configuration = (address.kind === "form" ? fixture.root.configuration : find(fixture.root, address.owner ?? "")?.configuration) as Bag | undefined;
  if (address.kind === "chrome") {
    const chrome = (fixture.root.configuration as Bag).chrome as Record<string, Array<Bag>>;
    const part = [...(chrome.header ?? []), ...(chrome.footer ?? [])].find((p) => p.id === address.owner);
    return String(part?.[address.path[0] as string] ?? "");
  }
  let value: unknown = configuration;
  for (let i = 0; i < address.path.length; i += 1) {
    const segment = address.path[i] as string;
    if (Array.isArray(value)) {
      value = value.find((item) => (item as Bag).value === segment);
    } else {
      value = (value as Bag)?.[segment];
    }
  }
  return String(value ?? "");
}

function fixtureTexts(): ExchangeText[] {
  const byKey = new Map<string, ExchangeText>();
  for (const { locale, address, entry } of listTranslations(fixture.translations)) {
    const key = JSON.stringify([address.kind, address.owner, address.path]);
    let text = byKey.get(key);
    if (!text) {
      text = {
        address,
        default: defaultOf(address),
        group: address.kind === "chrome" ? "Header & footer" : address.path[0] === "messages" ? "Messages" : address.path[0] === "options" ? "Options" : "Fields",
        where: address.owner ?? "Form",
        texts: {},
        sources: {}
      };
      byKey.set(key, text);
    }
    text.texts[locale] = entry.text;
    text.sources[locale] = entry.source;
  }
  return [...byKey.values()];
}

const TEXTS = fixtureTexts();
const TOTAL_CELLS = TEXTS.reduce((sum, text) => sum + Object.keys(text.texts).length, 0);

function preview(text: string, mode: "replace" | "fill" = "replace", texts: readonly ExchangeText[] = TEXTS) {
  return previewImport({ name: "f", text }, texts, ["en", ...LOCALES], { mode, defaultLocale: "en" });
}

const one = (patch: Partial<ExchangeText> = {}): ExchangeText => ({
  address: { kind: "components", owner: "a", path: ["label"] },
  default: "Name",
  group: "Fields",
  where: "Name",
  texts: {},
  sources: {},
  ...patch
});

describe("the fixture as exchange rows", () => {
  it("has the defaults and fingerprints the workspace will hand over", () => {
    expect(TEXTS.length).toBeGreaterThan(8);
    for (const text of TEXTS) {
      expect(text.default, JSON.stringify(text.address)).not.toBe("");
      for (const locale of Object.keys(text.texts)) {
        expect(text.sources[locale], JSON.stringify(text.address)).toBe(sourceHash(text.default));
      }
    }
  });
});

describe("export", () => {
  it("writes JSON with a header and one object per text, a source and a column per language", () => {
    const out = JSON.parse(exportJson(TEXTS, LOCALES, "all", HEADER)) as { form: string; defaultLocale: string; locales: string[]; exportedAt: string; texts: Array<Record<string, unknown>> };
    expect(out).toMatchObject({ form: "customer-intake", defaultLocale: "en", locales: LOCALES, exportedAt: "2026-10-28T00:00:00Z" });
    expect(out.texts).toHaveLength(TEXTS.length);
    const full = out.texts.find((row) => row.kind === "components" && row.key === "fullName" && row.path === "label");
    expect(full).toEqual({ kind: "components", key: "fullName", path: "label", where: "fullName", default: "Full name", source: sourceHash("Full name"), status: { "fr-CA": "fresh", es: "fresh" }, "fr-CA": "Nom complet", es: "Nombre completo" });
    const title = out.texts.find((row) => row.kind === "form");
    expect(title).toMatchObject({ key: "", path: "title", es: "", status: { es: "missing" } });
    expect(out.texts.find((row) => row.path === "options/phone/description")).toBeDefined();
  });

  it("omits the exportedAt and form a caller did not give, and writes no note", () => {
    const out = JSON.parse(exportJson([one()], ["fr"], "all", { defaultLocale: "en" })) as { exportedAt?: string; form?: string; texts: Array<Record<string, string>> };
    expect(out.exportedAt).toBeUndefined();
    expect(out.form).toBeUndefined();
    expect(out.texts[0]).not.toHaveProperty("note");
  });

  it("writes CSV with RFC 4180 quoting, CRLF rows and no byte-order mark", () => {
    const text = one({ default: 'Say "hi", then\nleave', where: "A, B", texts: { fr: 'Dis "salut"' }, sources: { fr: sourceHash("x") } });
    const csv = exportCsv([text], ["fr"], "all");
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
    expect(csv.startsWith("kind,key,path,where,default,source,lang:fr,status:fr\r\n")).toBe(true);
    expect(csv).toContain(`components,a,label,"A, B","Say ""hi"", then\nleave",${sourceHash('Say "hi", then\nleave')},"Dis ""salut""",stale\r\n`);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("spells an address segment that holds a slash, a space or a percent so the path stays unambiguous", () => {
    const text = one({ address: { kind: "components", owner: "pick", path: ["options", "a/b c%", "label"] } });
    const csv = exportCsv([text], ["fr"], "all");
    expect(csv).toContain("components,pick,options/a%2Fb%20c%25/label,");
    const back = preview(csv, "replace", [text]);
    expect(back.problems).toEqual([]);
  });

  it("writes XLIFF 2.0 per language: id from the address, default as source, text as target, escaped", () => {
    const text = one({ default: "Fish & <chips> \"'", texts: { fr: "Poisson & <frites>" }, sources: { fr: sourceHash("Fish & <chips> \"'") } });
    const xml = exportXliff([text, one({ address: { kind: "form", path: ["title"] }, default: "T" })], "fr", "all", HEADER);
    expect(xml).toContain('srcLang="en" trgLang="fr"');
    expect(xml).toContain('<unit id="components/a/label">');
    expect(xml).toContain("<source>Fish &amp; &lt;chips&gt; &quot;&apos;</source>");
    expect(xml).toContain("<target>Poisson &amp; &lt;frites&gt;</target>");
    expect(xml).toContain('<unit id="form/title">');
    expect(xml).toContain('state="translated"');
    expect(xml).toContain('state="initial"');
  });

  it("writes characters XML 1.0 cannot carry as cp elements, not dropping them", () => {
    const xml = exportXliff([one({ default: "T\u000bX\uffff", texts: { fr: "Titre\u0001" } })], "fr", "all", HEADER);
    expect(xml).toContain('<source>T<cp hex="000B"/>X<cp hex="FFFF"/></source>');
    expect(xml).toContain('<target>Titre<cp hex="0001"/></target>');
    expect(xml).not.toContain("\u000b");
  });

  it("makes a prompt of an instruction and the CSV", () => {
    const prompt = promptText(TEXTS, LOCALES, "all", HEADER);
    expect(prompt).toContain("lang:fr-CA, lang:es");
    expect(prompt).toContain("kind,key,path,where,default,source,lang:fr-CA,lang:es");
    expect(prompt.indexOf("Answer with")).toBeLessThan(prompt.indexOf("kind,key,path"));
  });

  it("writes a stale cell empty and says outdated cells are empty and must be filled", () => {
    const stale = one({ address: { kind: "components", owner: "s", path: ["label"] }, texts: { fr: "Vieux", es: "Nuevo" }, sources: { fr: "zzz", es: sourceHash("Name") } });
    const prompt = promptText([stale], ["fr", "es"], "all", HEADER);
    expect(prompt).toContain("changed since");
    const csvPart = prompt.slice(prompt.indexOf("kind,key,path"));
    expect(csvPart).not.toContain("Vieux");
    expect(csvPart).toContain("Nuevo");
    // The file the assistant answers with then imports as a change to the stale cell.
    const answered = csvPart.replace(",,Nuevo", ",Vieux2,Nuevo");
    expect(preview(answered, "replace", [stale]).rows.find((row) => row.locale === "fr")).toMatchObject({ status: "changed", text: "Vieux2" });
  });

  it("strips only the trailing line break of the prompt, not the last cell's spaces", () => {
    const prompt = promptText([one({ texts: { fr: "Nom  " }, sources: { fr: sourceHash("Name") } })], ["fr"], "all", HEADER);
    expect(prompt.endsWith("Nom  ")).toBe(true);
  });

  it("draws the prompt's rows from the scope before it blanks stale cells", () => {
    const stale = one({ address: { kind: "components", owner: "s", path: ["label"] }, texts: { fr: "Vieux" }, sources: { fr: "zzz" } });
    const prompt = promptText([stale, one({ address: { kind: "components", owner: "d", path: ["label"] }, texts: { fr: "Fait" }, sources: { fr: sourceHash("Name") } })], ["fr"], "stale", HEADER);
    expect(prompt).toContain("components,s,label");
    expect(prompt).not.toContain("components,d,label");
  });

  it("narrows by scope: missing, stale, one group", () => {
    const stale = one({ address: { kind: "components", owner: "s", path: ["label"] }, texts: { fr: "Vieux" }, sources: { fr: "zzz" } });
    const done = one({ address: { kind: "components", owner: "d", path: ["label"] }, texts: { fr: "Fait" }, sources: { fr: sourceHash("Name") } });
    const empty = one({ address: { kind: "components", owner: "e", path: ["label"] }, group: "Messages" });
    const all = [stale, done, empty];
    expect(textsInScope(all, ["fr"], "missing").map((t) => t.address.owner)).toEqual(["e"]);
    expect(textsInScope(all, ["fr"], "stale").map((t) => t.address.owner)).toEqual(["s"]);
    expect(textsInScope(all, ["fr"], { group: "Messages" }).map((t) => t.address.owner)).toEqual(["e"]);
    expect(textsInScope(all, ["fr"], "all")).toHaveLength(3);
    expect(JSON.parse(exportJson(all, ["fr"], "stale", HEADER)).texts).toHaveLength(1);
    expect(exportCsv(all, ["fr"], "missing").split("\r\n")).toHaveLength(3);
    expect(exportXliff(all, "fr", "missing", HEADER).match(/<unit /g)).toHaveLength(1);
  });
});

describe("round trips from the canonical fixture", () => {
  function expectUnchanged(text: string, cells = TOTAL_CELLS) {
    const result = preview(text);
    expect(result.problems).toEqual([]);
    expect(result.counts).toEqual({ new: 0, changed: 0, unchanged: cells, unknown: 0, skipped: 0, stale: 0 });
    expect(result.rows).toHaveLength(cells);
    expect(result.newLocales).toEqual([]);
    expect(result.unknownCount).toBe(0);
    expect(applyImport(result, { addLocales: [], mode: "replace" }).edits).toEqual([]);
  }

  it("JSON", () => {
    const json = exportJson(TEXTS, LOCALES, "all", HEADER);
    expect(preview(json).format).toBe("json");
    expectUnchanged(json);
  });

  it("CSV, with a byte-order mark and with semicolons", () => {
    const csv = exportCsv(TEXTS, LOCALES, "all");
    expect(preview(csv).format).toBe("csv");
    expectUnchanged(csv);
    expectUnchanged(`﻿${csv}`);
    // A spreadsheet in a French locale writes `;`.
    const semicolons = csv
      .split("\r\n")
      .map((line) => line.replace(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/g, ";"))
      .join("\r\n");
    expectUnchanged(semicolons);
  });

  it("every kind: a journeys text and a pdf text with awkward segments round-trip in all three formats", () => {
    const journeys = one({
      address: { kind: "journeys", owner: "main", path: ["pages", "intro page", "title"] },
      default: "Start here",
      group: "Journeys",
      texts: { "fr-CA": "Commencez ici" },
      sources: { "fr-CA": sourceHash("Start here") }
    });
    const pdf = one({
      address: { kind: "pdf", owner: "layout/1", path: ["blocks", "50%", "text"] },
      default: "Receipt",
      group: "PDF",
      texts: { es: "Recibo" },
      sources: { es: sourceHash("Receipt") }
    });
    const rows = [journeys, pdf];
    for (const text of [exportJson(rows, LOCALES, "all", HEADER), exportCsv(rows, LOCALES, "all")]) {
      const result = preview(text, "replace", rows);
      expect(result.problems).toEqual([]);
      expect(result.counts).toEqual({ new: 0, changed: 0, unchanged: 2, unknown: 0, skipped: 0, stale: 0 });
    }
    for (const [locale, kind] of [["fr-CA", "journeys"], ["es", "pdf"]] as const) {
      const result = preview(exportXliff(rows, locale, "all", HEADER), "replace", rows);
      expect(result.problems).toEqual([]);
      expect(result.rows.map((row) => [row.address.kind, row.status])).toEqual([[kind, "unchanged"]]);
    }
  });

  it("XLIFF keeps characters XML 1.0 cannot carry, in a translation and in a default", () => {
    const text = one({ default: "T\u000bX", texts: { fr: "Titre\u000b\ufffe" }, sources: { fr: sourceHash("T\u000bX") } });
    const result = preview(exportXliff([text], "fr", "all", HEADER), "replace", [text]);
    expect(result.problems).toEqual([]);
    expect(result.rows[0]).toMatchObject({ status: "unchanged", stale: false, text: "Titre\u000b\ufffe" });
  });

  it("XLIFF, one file per language", () => {
    for (const locale of LOCALES) {
      const cells = TEXTS.filter((text) => text.texts[locale]).length;
      const result = preview(exportXliff(TEXTS, locale, "all", HEADER));
      expect(result.format).toBe("xliff");
      expect(result.problems).toEqual([]);
      expect(result.counts).toEqual({ new: 0, changed: 0, unchanged: cells, unknown: 0, skipped: 0, stale: 0 });
      expect(result.rows.every((row) => row.locale === locale)).toBe(true);
    }
  });
});

describe("reading CSV", () => {
  it("keeps quotes, commas and newlines in a cell", () => {
    const text = one({ default: "Name", texts: {} });
    const csv = `kind,key,path,where,default,source,lang:fr\r\ncomponents,a,label,Name,Name,${sourceHash("Name")},"Nom, ""complet""\r\nsur deux lignes"\r\n`;
    const result = preview(csv, "replace", [text]);
    expect(result.problems).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ locale: "fr", text: 'Nom, "complet"\nsur deux lignes', status: "new", newLocale: true });
  });

  it("reads a row without a trailing newline, blank lines and short rows", () => {
    const csv = `kind,key,path,lang:fr\ncomponents,a,label,Nom\n\ncomponents,a,description`;
    const result = preview(csv, "replace", [one(), one({ address: { kind: "components", owner: "a", path: ["description"] } })]);
    expect(result.rows.map((row) => row.text)).toEqual(["Nom"]);
  });

  it("skips blank lines before the row cap counts them, and a problem's row is its place in the file", () => {
    const rows = Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => `components,a${i},label,x`).join("\r\n");
    const padded = preview(`kind,key,path,lang:fr-CA\r\n${rows}\r\n\r\n\r\n`);
    expect(padded.problems).toEqual([]);
    expect(padded.rows).toHaveLength(MAX_IMPORT_ROWS);
    const shifted = preview("kind,key,path,lang:fr-CA\r\n\r\n\r\nwidgets,a,label,y\r\n");
    expect(shifted.problems).toEqual([{ code: "badAddress", row: 3, detail: "widgets" }]);
  });

  it("refuses an unterminated quote and a file without the address columns", () => {
    expect(preview('kind,key,path,lang:fr\ncomponents,a,label,"open').problems).toEqual([{ code: "malformedCsv" }]);
    expect(preview("name,value\na,b").problems).toEqual([{ code: "missingColumns" }]);
  });
});

describe("reading XLIFF", () => {
  const doc = (body: string, attrs = 'trgLang="fr"') => `<?xml version="1.0"?><xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0" srcLang="en" ${attrs}><file id="f">${body}</file></xliff>`;
  const unit = (id: string, source: string, target: string) => `<unit id="${id}"><segment><source>${source}</source><target>${target}</target></segment></unit>`;

  it("decodes entities, CDATA and character references", () => {
    const result = preview(doc(unit("components/a/label", "Name", "Nom &amp; &#233;t&#xE9; <![CDATA[<b>]]>")), "replace", [one()]);
    expect(result.problems).toEqual([]);
    expect(result.rows[0]?.text).toBe("Nom & été <b>");
  });

  it("reads the text of inline markup a tool added, an empty placeholder as its equiv or disp", () => {
    const result = preview(doc(unit("components/a/label", "Name", 'Nom <ph id="1" equiv="{{n}}"/>de <ph id="3" disp="[x]"/><pc id="2">famille</pc>')), "replace", [one()]);
    expect(result.rows[0]?.text).toBe("Nom {{n}}de [x]famille");
    expect(result.problems).toEqual([]);
  });

  it("reports a placeholder with nothing to stand for it instead of importing a shortened text", () => {
    const result = preview(doc(unit("components/a/label", "Name", 'Nom <ph id="1"/>')), "replace", [one()]);
    expect(result.rows).toEqual([]);
    expect(result.problems).toEqual([{ code: "badCell", row: 1, detail: "components/a/label" }]);
  });

  it("refuses malformed XML, a document type declaration and a missing language", () => {
    // A break inside a unit names it; one outside every unit does not.
    expect(preview("<xliff trgLang='fr'><file><unit id='x'></file></xliff>").problems).toEqual([{ code: "malformedXml", detail: "x" }]);
    expect(preview("<xliff trgLang='fr'>").problems).toEqual([{ code: "malformedXml" }]);
    expect(preview("<xliff trgLang='fr'></xliff><extra/>").problems).toEqual([{ code: "malformedXml" }]);
    expect(preview(doc(unit("components/a/label", "Name", "a &bogus; b"))).problems).toEqual([{ code: "malformedXml", detail: "components/a/label" }]);
    expect(preview('<?xml version="1.0"?><!DOCTYPE xliff [<!ENTITY x "boom">]><xliff trgLang="fr"/>').problems).toEqual([{ code: "unsafeXml" }]);
    expect(preview(doc(unit("components/a/label", "Name", "Nom"), "")).problems).toEqual([{ code: "missingTargetLanguage" }]);
    expect(preview("<html><body/></html>").problems).toEqual([{ code: "notXliff" }]);
  });

  it("caps the nesting depth", () => {
    const deep = `<xliff trgLang="fr">${"<g>".repeat(200)}${"</g>".repeat(200)}</xliff>`;
    expect(preview(deep).problems).toEqual([{ code: "malformedXml" }]);
  });

  it("reads a unit with no target as nothing and a unit with no id as a bad address", () => {
    const result = preview(doc(`<unit id="components/a/label"><segment><source>Name</source></segment></unit><unit><segment><source>x</source></segment></unit>`), "replace", [one()]);
    expect(result.rows).toEqual([]);
    expect(result.problems).toEqual([{ code: "badAddress", row: 2 }]);
  });

  it("counts a unit with a source and no target as left out, not an empty target", () => {
    const body = `<unit id="components/a/label"><segment><source>Name</source></segment></unit>${unit("components/b/label", "Other", "")}`;
    const result = preview(doc(body), "replace", [one()]);
    expect(result.noTargetCount).toBe(1);
    expect(result.rows).toEqual([]);
  });
});

describe("a cell over the byte cap", () => {
  it("skips a translation over 16 KiB of UTF-8 with a tooLong problem and keeps the others", () => {
    const long = "é".repeat(MAX_IMPORT_CELL_BYTES / 2 + 1);
    const result = preview(`kind,key,path,lang:fr-CA\ncomponents,a,label,${long}\ncomponents,b,label,ok`, "replace", [one(), one({ address: { kind: "components", owner: "b", path: ["label"] } })]);
    expect(result.problems).toEqual([{ code: "tooLong", row: 1, detail: "fr-CA" }]);
    expect(result.rows.map((row) => row.text)).toEqual(["ok"]);
  });

  it("accepts a cell of exactly the cap, counted in bytes not characters", () => {
    const exact = "é".repeat(MAX_IMPORT_CELL_BYTES / 2);
    const result = preview(`kind,key,path,lang:fr-CA\ncomponents,a,label,${exact}`, "replace", [one()]);
    expect(result.problems).toEqual([]);
    expect(result.rows).toHaveLength(1);
    const ascii = "x".repeat(MAX_IMPORT_CELL_BYTES + 1);
    expect(preview(`kind,key,path,lang:fr-CA\ncomponents,a,label,${ascii}`, "replace", [one()]).problems.map((p) => p.code)).toEqual(["tooLong"]);
  });
});

describe("the counts of the languages that would be applied", () => {
  it("leaves out the rows of a new language the author has not ticked", () => {
    const result = preview("kind,key,path,lang:fr-CA,lang:de\ncomponents,a,label,Nom,Name de", "replace", [one()]);
    expect(result.counts.new).toBe(2);
    expect(countsFor(result, []).new).toBe(1);
    expect(countsFor(result, ["de"]).new).toBe(2);
  });
});

describe("the preview", () => {
  const csv = (rows: string[]) => ["kind,key,path,source,lang:fr-CA,lang:de", ...rows].join("\n");

  it("classifies new, changed, unchanged and unknown rows", () => {
    const texts = [
      one({ address: { kind: "components", owner: "n", path: ["label"] } }),
      one({ address: { kind: "components", owner: "c", path: ["label"] }, texts: { "fr-CA": "Ancien" } }),
      one({ address: { kind: "components", owner: "u", path: ["label"] }, texts: { "fr-CA": "Pareil" } })
    ];
    const result = preview(
      csv(["components,n,label,,Nouveau,", "components,c,label,,Changé,", "components,u,label,,Pareil,", "components,ghost,label,,Fantôme,"]),
      "replace",
      texts
    );
    expect(result.rows.map((row) => row.status)).toEqual(["new", "changed", "unchanged", "unknown"]);
    expect(result.counts).toEqual({ new: 1, changed: 1, unchanged: 1, unknown: 1, skipped: 0, stale: 0 });
    expect(result.unknownCount).toBe(1);
    expect(result.rows[1]?.current).toBe("Ancien");
  });

  it("lists a language the form lacks, spelled with a hyphen, only when something of it would apply", () => {
    const result = preview(csv(["components,a,label,,,Name_de", "components,ghost,label,,,Geist"].map((r) => r.replace("Name_de", "Name"))), "replace", [one()]);
    expect(result.newLocales).toEqual(["de"]);
    const underscored = preview("kind,key,path,lang:pt_BR\ncomponents,a,label,Nome", "replace", [one()]);
    expect(underscored.newLocales).toEqual(["pt-BR"]);
    const onlyUnknown = preview("kind,key,path,lang:de\ncomponents,ghost,label,Geist", "replace", [one()]);
    expect(onlyUnknown.newLocales).toEqual([]);
  });

  it("takes only what the controller accepts as a language code for a new language", () => {
    const result = preview("kind,key,path,Notes,lang:fr-CA,lang:Notes,lang:Status,lang:ID,lang:Comments,lang:toString,lang:constructor,lang:de\ncomponents,a,label,note,Nom,n,s,7,c,t,k,Name-de", "replace", [one()]);
    // An unprefixed column (Notes) is no language; a prefixed code is one when it is shaped like one (ID is Indonesian).
    expect(result.rows.map((row) => row.locale)).toEqual(["fr-CA", "ID", "de"]);
    expect(result.newLocales).toEqual(["ID", "de"]);
    expect(result.problems.map((p) => [p.code, p.detail])).toEqual([
      ["badLocale", "Notes"],
      ["badLocale", "Status"],
      ["badLocale", "Comments"],
      ["badLocale", "toString"],
      ["badLocale", "constructor"]
    ]);
  });

  it("does not read the prototype chain for a column named like an Object method", () => {
    const text = one({ texts: {} });
    const result = preview("kind,key,path,lang:valueOf\ncomponents,a,label,x", "replace", [text]);
    expect(result.rows).toEqual([]);
    // A declared language that is also an Object member name cannot be reached either way.
    const declared = previewImport({ name: "f", text: "kind,key,path,lang:valueOf\ncomponents,a,label,x" }, [text], ["en", "valueOf"], { mode: "replace", defaultLocale: "en" });
    expect(declared.rows[0]).toMatchObject({ status: "new" });
    expect(declared.rows[0]).not.toHaveProperty("current");
  });

  it("matches a declared language in any spelling, and ignores the default language's column", () => {
    const result = preview("kind,key,path,lang:fr_ca,lang:EN\ncomponents,a,label,Nom,Name", "replace", [one()]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ locale: "fr-CA", newLocale: false });
    expect(result.problems).toEqual([{ code: "defaultLocaleColumn", row: 1, detail: "EN" }]);
  });

  it("flags a row whose source no longer matches, and still counts it", () => {
    const result = preview(csv([`components,a,label,${sourceHash("Old name")},Ancien nom,`, `components,a,label,${sourceHash("Name")},Nom,`]), "replace", [one(), one({ address: { kind: "components", owner: "b", path: ["label"] } })]);
    // The second row is the same cell as the first: the later one replaces it, with a problem.
    expect(result.rows).toHaveLength(1);
    expect(result.problems).toContainEqual({ code: "duplicateRow", row: 2, detail: "fr-CA" });
    expect(result.rows[0]?.stale).toBe(false);
    const stale = preview(csv([`components,a,label,${sourceHash("Old name")},Ancien nom,`]), "replace", [one()]);
    expect(stale.rows[0]).toMatchObject({ stale: true, status: "new", source: sourceHash("Old name") });
    expect(stale.counts.stale).toBe(1);
    const unstated = preview(csv(["components,a,label,,Nom,"]), "replace", [one()]);
    expect(unstated.rows[0]?.stale).toBe(false);
  });

  it("treats a blank cell as no translation, never as a deletion", () => {
    const result = preview(csv(["components,a,label,,,"]), "replace", [one({ texts: { "fr-CA": "Nom" } })]);
    expect(result.rows).toEqual([]);
  });

  it("reads the XLIFF source text as the fingerprint", () => {
    const body = (source: string) => `<xliff trgLang="fr"><file id="f"><unit id="components/a/label"><segment><source>${source}</source><target>Nom</target></segment></unit></file></xliff>`;
    expect(preview(body("Name"), "replace", [one()]).rows[0]?.stale).toBe(false);
    expect(preview(body("Old"), "replace", [one()]).rows[0]?.stale).toBe(true);
  });
});

describe("applying", () => {
  const texts = [
    one({ address: { kind: "components", owner: "n", path: ["label"] } }),
    one({ address: { kind: "components", owner: "c", path: ["label"] }, texts: { fr: "Ancien" } }),
    one({ address: { kind: "components", owner: "u", path: ["label"] }, texts: { fr: "Pareil" } })
  ];
  const file = "kind,key,path,source,lang:fr,lang:de\ncomponents,n,label,,Nouveau,Neu\ncomponents,c,label,,Changé,\ncomponents,u,label,,Pareil,\ncomponents,ghost,label,,Fantôme,";
  const preview2 = (mode: "replace" | "fill") => previewImport({ name: "x", text: file }, texts, ["en", "fr"], { mode, defaultLocale: "en" });
  const addresses = (edits: Array<{ address: TextAddress; locale: string }>) => edits.map((e) => `${e.locale}:${e.address.owner}`);

  it("replace writes new and changed rows, not unchanged or unknown ones, and not a language nobody added", () => {
    const edits = applyImport(preview2("replace"), { addLocales: [], mode: "replace" }).edits;
    expect(addresses(edits)).toEqual(["fr:n", "fr:c"]);
    expect(edits[1]).toEqual({ locale: "fr", address: { kind: "components", owner: "c", path: ["label"] }, text: "Changé" });
  });

  it("fill writes only blanks; the mode is the one given at apply time", () => {
    expect(addresses(applyImport(preview2("replace"), { addLocales: [], mode: "fill" }).edits)).toEqual(["fr:n"]);
  });

  it("adds a language only when chosen, in any spelling", () => {
    const edits = applyImport(preview2("replace"), { addLocales: ["DE"], mode: "replace" }).edits;
    expect(addresses(edits)).toEqual(["fr:n", "de:n", "fr:c"]);
  });

  it("imports a stale row, carrying the file's source for the caller to keep it flagged", () => {
    const stale = previewImport({ name: "x", text: `kind,key,path,source,lang:fr\ncomponents,n,label,${sourceHash("Old")},Ancien` }, texts, ["en", "fr"], { mode: "replace" });
    const edits = applyImport(stale, { addLocales: [], mode: "replace" }).edits;
    expect(edits).toEqual([{ locale: "fr", address: { kind: "components", owner: "n", path: ["label"] }, text: "Ancien", source: sourceHash("Old") }]);
    const current = previewImport({ name: "x", text: `kind,key,path,source,lang:fr\ncomponents,n,label,${sourceHash("Name")},Nom` }, texts, ["en", "fr"], { mode: "replace" });
    expect(applyImport(current, { addLocales: [], mode: "replace" }).edits[0]).not.toHaveProperty("source");
  });

  it("answers whether a row applies, for the diff", () => {
    const rows = preview2("replace").rows;
    expect(rows.map((row) => [willApply(row, "replace"), willApply(row, "fill")])).toEqual([
      [true, true],
      [true, true],
      [true, false],
      [false, false],
      [false, false]
    ]);
  });
});

describe("unknown addresses and hostile files", () => {
  it("counts unknown addresses by distinct text and keeps them out of the edits", () => {
    const result = preview("kind,key,path,lang:fr-CA,lang:es\ncomponents,ghost,label,A,B\ncomponents,ghost2,label,C,\nform,,nothing,D,");
    expect(result.unknownCount).toBe(3);
    expect(result.counts.unknown).toBe(4);
    expect(applyImport(result, { addLocales: [], mode: "replace" }).edits).toEqual([]);
  });

  it("refuses unsafe segments in every route", () => {
    for (const bad of ["__proto__", "constructor", "prototype"]) {
      const result = preview(`kind,key,path,lang:fr-CA\ncomponents,${bad},label,x\ncomponents,a,options/${bad}/label,y`);
      expect(result.rows).toEqual([]);
      expect(result.problems.map((p) => p.code)).toEqual(["unsafeSegment", "unsafeSegment"]);
    }
    const xliff = preview(`<xliff trgLang="fr-CA"><file id="f"><unit id="components/__proto__/label"><segment><source>a</source><target>b</target></segment></unit></file></xliff>`);
    expect(xliff.problems.map((p) => p.code)).toEqual(["unsafeSegment"]);
  });

  it("holds against __proto__ keys in JSON: as a column, a row, a path array and a header", () => {
    const text = `{"__proto__":{"polluted":true},"texts":[
      {"kind":"components","key":"a","path":"label","__proto__":"x","fr-CA":"Nom","constructor":"y"},
      {"__proto__":{"kind":"components"},"kind":"components","key":"a","path":["__proto__","label"],"fr-CA":"Z"},
      {"kind":"components","key":"a","path":["label"],"fr-CA":"Nom 2"}
    ]}`;
    const result = preview(text, "replace", [one()]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(result.rows.map((row) => row.text)).toEqual(["Nom 2"]);
    expect(result.problems.map((p) => p.code).sort()).toEqual(["badCell", "badLocale", "badLocale", "duplicateRow", "unsafeSegment"]);
  });

  it("tells a JSON array from an object and refuses anything else", () => {
    const row = { kind: "components", key: "a", path: "label", "fr-CA": "Nom" };
    const asArray = preview(JSON.stringify([row]), "replace", [one()]);
    const asObject = preview(JSON.stringify({ defaultLocale: "en", texts: [row] }), "replace", [one()]);
    expect(asArray.rows).toEqual(asObject.rows);
    expect(asArray.rows).toHaveLength(1);
    expect(preview(JSON.stringify({ defaultLocale: "en" })).problems).toEqual([{ code: "unrecognizedShape" }]);
    expect(preview('{"texts": "no"}').problems).toEqual([{ code: "unrecognizedShape" }]);
    expect(preview('{"texts": [').problems).toEqual([{ code: "malformedJson" }]);
    expect(preview(JSON.stringify([1, "a", null, row]), "replace", [one()]).problems.map((p) => p.code)).toEqual(["unrecognizedShape", "unrecognizedShape", "unrecognizedShape"]);
  });

  it("refuses a file over 4 MiB without reading it", () => {
    const big = `kind,key,path,lang:fr-CA\ncomponents,a,label,${"x".repeat(MAX_IMPORT_BYTES + 1)}`;
    const result = preview(big);
    expect(result.problems).toEqual([{ code: "tooLarge" }]);
    expect(result.rows).toEqual([]);
    // Five MiB of padding in JSON, the same.
    expect(preview(`[${" ".repeat(5 * 1024 * 1024)}]`).problems).toEqual([{ code: "tooLarge" }]);
    // Under the cap in characters but over in bytes.
    const multibyte = `kind,key,path,lang:fr-CA\ncomponents,a,label,${"é".repeat(2.2 * 1024 * 1024)}`;
    expect(preview(multibyte).problems).toEqual([{ code: "tooLarge" }]);
  });

  it("refuses more than 20,000 rows in every format", () => {
    const rows = MAX_IMPORT_ROWS + 5000;
    const csv = `kind,key,path,lang:fr-CA\n${Array.from({ length: rows }, (_, i) => `components,a${i},label,x`).join("\n")}`;
    expect(preview(csv).problems).toEqual([{ code: "tooManyRows" }]);
    const json = JSON.stringify(Array.from({ length: rows }, (_, i) => ({ kind: "components", key: `a${i}`, path: "label", "fr-CA": "x" })));
    expect(preview(json).problems).toEqual([{ code: "tooManyRows" }]);
    const units = Array.from({ length: rows }, (_, i) => `<unit id="components/a${i}/label"><segment><source>s</source><target>x</target></segment></unit>`).join("");
    expect(preview(`<xliff trgLang="fr-CA"><file id="f">${units}</file></xliff>`).problems).toEqual([{ code: "tooManyRows" }]);
  });

  it("accepts a file of exactly the row cap", () => {
    const csv = `kind,key,path,lang:fr-CA\n${Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => `components,a${i},label,x`).join("\n")}`;
    const result = preview(csv);
    expect(result.problems).toEqual([]);
    expect(result.rows).toHaveLength(MAX_IMPORT_ROWS);
    expect(result.counts.unknown).toBe(MAX_IMPORT_ROWS);
  });

  it("refuses an empty file, a header with a thousand columns, and bad locale codes, never throwing", () => {
    expect(preview("   \n").problems).toEqual([{ code: "empty" }]);
    expect(preview("").problems).toEqual([{ code: "empty" }]);
    const wide = `kind,key,path,${Array.from({ length: 1000 }, (_, i) => `c${i}`).join(",")}\ncomponents,a,label`;
    expect(preview(wide).problems).toEqual([{ code: "tooManyLocales" }]);
    const bad = preview("kind,key,path,lang:<script>,lang:x y\ncomponents,a,label,1,2", "replace", [one()]);
    expect(bad.problems.map((p) => p.code)).toEqual(["badLocale", "badLocale"]);
    expect(bad.rows).toEqual([]);
  });

  it("caps the problem list of a file that is nothing but problems", () => {
    const csv = `kind,key,path,lang:fr-CA\n${Array.from({ length: 5000 }, () => "nope,a,label,x").join("\n")}`;
    const result = preview(csv);
    expect(result.problems.length).toBeLessThanOrEqual(201);
    expect(result.problems[result.problems.length - 1]).toEqual({ code: "moreProblems" });
  });

  it("refuses a bad percent escape and a bad kind without throwing", () => {
    const result = preview("kind,key,path,lang:fr-CA\ncomponents,a,50%,x\nwidgets,a,label,y\nform,owner,title,z\ncomponents,,label,w");
    expect(result.problems.map((p) => p.code)).toEqual(["badAddress", "badAddress", "badAddress", "badAddress"]);
  });
});

describe("a CSV row that does not line up with its header", () => {
  const header = "kind,key,path,where,default,source,lang:fr-CA,lang:es";
  const hash = sourceHash("Name");

  it("is reported and left out when a comma lost its quotes, never read one column to the left", () => {
    // "Address, line 1" without quotes spills one field into the row: the fingerprint would
    // land in French and the status word in Spanish.
    const csv = [header, `components,a,label,Address, line 1,Name,${hash},Nom,Nombre`, `components,b,label,Other,Other,${sourceHash("Other")},Autre,`, ""].join("\r\n");
    const result = preview(csv, "replace", [one(), one({ address: { kind: "components", owner: "b", path: ["label"] }, default: "Other" })]);
    expect(result.problems).toEqual([{ code: "badRow", row: 1 }]);
    expect(result.rows.map((row) => [row.address.owner, row.locale, row.text])).toEqual([["b", "fr-CA", "Autre"]]);
  });

  it("reads a row whose stated source is no fingerprint as misaligned", () => {
    const csv = [header, `components,a,label,Name,Name,not a hash,Nom,Nombre`, ""].join("\r\n");
    const result = preview(csv, "replace", [one()]);
    expect(result.problems).toEqual([{ code: "badRow", row: 1 }]);
    expect(result.rows).toEqual([]);
  });

  it("still takes a short row and trailing empty fields", () => {
    const csv = [header, `components,a,label,Name,Name,${hash},Nom,,,`, `components,a,description,Name,Name,${hash}`, ""].join("\r\n");
    const result = preview(csv, "replace", [one()]);
    expect(result.problems).toEqual([]);
    expect(result.rows.map((row) => row.text)).toEqual(["Nom"]);
  });
});

describe("texts a language has no cell for, and texts the page's catalog words", () => {
  const engine = (patch: Partial<ExchangeText> = {}): ExchangeText =>
    one({ address: { kind: "texts", owner: "form", path: ["summaryHeading"] }, default: "Summary", applicable: new Set(["fr-CA"]), ...patch });

  it("never counts a language without a cell missing, and leaves its cell and status blank", () => {
    const text = engine();
    expect(textsInScope([text], ["es"], "missing")).toEqual([]);
    expect(textsInScope([text], ["fr-CA"], "missing")).toEqual([text]);
    const csv = exportCsv([text], ["fr-CA", "es"], "all");
    expect(csv.split("\r\n")[1]).toMatch(/,,missing,,$/);
    const json = JSON.parse(exportJson([text], ["fr-CA", "es"], "all", HEADER)) as { texts: Array<{ status: Record<string, string> }> };
    expect(json.texts[0]?.status).toEqual({ "fr-CA": "missing" });
    expect(exportXliff([text], "es", "all", HEADER)).not.toContain("<unit");
    expect(exportXliff([text], "fr-CA", "all", HEADER)).toContain("<unit");
  });

  it("skips an imported cell for a language the text has no cell for, and for a cell the catalog words", () => {
    const text = engine({ catalog: { "fr-CA": "overridden" } });
    const csv = ["kind,key,path,lang:fr-CA,lang:es", "texts,form,summaryHeading,Sommaire,Resumen", ""].join("\r\n");
    const result = preview(csv, "replace", [text]);
    expect(result.rows.map((row) => [row.locale, row.status])).toEqual([
      ["fr-CA", "pageWorded"],
      ["es", "noCell"]
    ]);
    expect(applyImport(result, { addLocales: [], mode: "replace" }).edits).toEqual([]);
    // Each skip has its own count and none is an unknown text.
    expect(result.counts).toMatchObject({ unknown: 0, skipped: 2 });
    expect(result.unknownCount).toBe(0);
  });

  it("does not call a catalog-worded cell missing or stale, and a page-served one is not missing", () => {
    const overridden = one({ texts: { "fr-CA": "Nom" }, sources: { "fr-CA": "stale" }, catalog: { "fr-CA": "overridden" } });
    const served = one({ catalog: { "fr-CA": "served" } });
    expect(textsInScope([overridden, served], ["fr-CA"], "missing")).toEqual([]);
    expect(textsInScope([overridden], ["fr-CA"], "stale")).toEqual([]);
    expect(textsInScope([overridden, served], ["fr-CA"], "all")).toHaveLength(2);
    expect(exportCsv([overridden], ["fr-CA"], "all")).toContain(",Nom,fresh");
    expect(exportCsv([served], ["fr-CA"], "all")).toContain(",,fresh");
  });
});

describe("XLIFF protected inline codes", () => {
  const doc = (target: string) =>
    `<?xml version="1.0"?><xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0" srcLang="en" trgLang="fr"><file id="f"><unit id="components/a/label"><segment><source>Name</source><target>${target}</target></segment></unit></file></xliff>`;

  it("reads an empty start or end code as its equiv or disp", () => {
    const result = preview(doc('Lisez <sc id="1" disp="&lt;b&gt;"/>ceci<ec startRef="1" equiv="&lt;/b&gt;"/>'), "replace", [one()]);
    expect(result.problems).toEqual([]);
    expect(result.rows[0]?.text).toBe("Lisez <b>ceci</b>");
  });

  it("reports a start or end code with nothing to stand for it instead of dropping the markup", () => {
    const result = preview(doc('Lisez <sc id="1"/>ceci<ec startRef="1"/>'), "replace", [one()]);
    expect(result.rows).toEqual([]);
    expect(result.problems).toEqual([{ code: "badCell", row: 1, detail: "components/a/label" }]);
  });
});

describe("the CSV file's byte-order mark", () => {
  const texts = [one({ texts: { fr: "Nom" }, sources: { fr: sourceHash("Name") } })];

  it("leads a saved file so Excel reads it as UTF-8, and the import reads that file back", () => {
    const file = exportCsv(texts, ["fr"], "all", { bom: true });
    expect(file.charCodeAt(0)).toBe(0xfeff);
    expect(file.slice(1).startsWith("kind,key,path")).toBe(true);
    const result = previewImport({ name: "f", text: file }, texts, ["en", "fr"], { mode: "replace", defaultLocale: "en" });
    expect(result.problems).toEqual([]);
    expect(result.counts.unchanged).toBe(1);
  });

  it("is left off the text that is pasted into an assistant, and off a file unless asked", () => {
    expect(exportCsv(texts, ["fr"], "all").charCodeAt(0)).toBe("k".charCodeAt(0));
    expect(promptText(texts, ["fr"], "all", HEADER)).not.toContain("\ufeff");
  });
});

describe("the engine's own words in a non-English default language", () => {
  const summary = addressOf.formText("summaryHeading");
  const engine = (patch: Partial<ExchangeText> = {}): ExchangeText => ({
    address: summary,
    default: "Summary",
    group: "texts",
    where: "Form text",
    texts: {},
    sources: {},
    applicable: new Set(["fr", "es"]),
    ...patch
  });
  const field = (patch: Partial<ExchangeText> = {}): ExchangeText => one({ applicable: new Set(["es"]), ...patch });
  const french = (text: string, rows: readonly ExchangeText[]) => previewImport({ name: "f", text }, rows, ["fr", "es"], { mode: "replace", defaultLocale: "fr" });

  it("exports a cell for the default language only on the engine's rows", () => {
    const csv = exportCsv([engine(), field()], ["fr", "es"], "all").split("\r\n");
    expect(csv[1]).toMatch(/,Summary,\w+,,missing,,missing$/);
    expect(csv[2]).toMatch(/,Name,\w+,,,,missing$/);
    const json = JSON.parse(exportJson([engine(), field()], ["fr", "es"], "all", { ...HEADER, defaultLocale: "fr" })) as { texts: Array<{ status: Record<string, string> }> };
    expect(json.texts.map((row) => Object.keys(row.status))).toEqual([["fr", "es"], ["es"]]);
  });

  it("reads the default language's column for an engine word and refuses it, once, for any other text", () => {
    const csv = ["kind,key,path,lang:fr,lang:es", "texts,form,summaryHeading,Sommaire,Resumen", "components,a,label,Nom,Nombre", "components,a,description,Texte,", ""].join("\r\n");
    const result = french(csv, [engine(), field(), field({ address: { kind: "components", owner: "a", path: ["description"] } })]);
    expect(result.rows.map((row) => [row.address.kind, row.locale, row.status])).toEqual([
      ["texts", "fr", "new"],
      ["texts", "es", "new"],
      ["components", "es", "new"]
    ]);
    expect(result.problems).toEqual([{ code: "defaultLocaleColumn", row: 2, detail: "fr" }]);
    expect(applyImport(result, { addLocales: [], mode: "replace" }).edits.map((edit) => [edit.locale, edit.address.kind])).toEqual([
      ["fr", "texts"],
      ["es", "texts"],
      ["es", "components"]
    ]);
  });

  it("skips the default language's cell of an engine word when that language is English", () => {
    const rows = [engine({ applicable: new Set(["es"]) })];
    const result = previewImport({ name: "f", text: "kind,key,path,lang:en\ntexts,form,summaryHeading,Summary" }, rows, ["en", "es"], { mode: "replace", defaultLocale: "en" });
    expect(result.rows.map((row) => row.status)).toEqual(["noCell"]);
    expect(applyImport(result, { addLocales: [], mode: "replace" }).edits).toEqual([]);
  });

  it("judges the engine words of a language the import adds by their address", () => {
    const plural = addressOf.formText("summaryHeading.few");
    const rows = [engine(), engine({ address: plural })];
    const csv = (code: string) => `kind,key,path,lang:${code}\ntexts,form,summaryHeading,Words\ntexts,form,summaryHeading.few,Words`;
    // English is the engine words' own language: nothing to write there.
    const english = french(csv("en"), rows);
    expect(english.rows.map((row) => row.status)).toEqual(["noCell", "noCell"]);
    expect(english.newLocales).toEqual([]);
    expect(english.counts).toMatchObject({ skipped: 2, new: 0 });
    // A language whose plural rules have no `few` has no such form; one that has it does.
    expect(french(csv("de"), rows).rows.map((row) => row.status)).toEqual(["new", "noCell"]);
    const polish = french(csv("pl"), rows);
    expect(polish.rows.map((row) => row.status)).toEqual(["new", "new"]);
    expect(polish.newLocales).toEqual(["pl"]);
  });
  it("finds the engine word of a language the import adds in the engine's own list when the form has no row for it", () => {
    // The form lists no engine rows (a fr-only form): once pl is added the grid has them.
    const csv = "kind,key,path,lang:pl\ntexts,form,summaryHeading,Podsumowanie\ntexts,form,summaryHeading.few,Podsumowania\ntexts,form,notAWord,x";
    const result = previewImport({ name: "f", text: csv }, [field()], ["fr"], { mode: "replace", defaultLocale: "fr" });
    expect(result.rows.map((row) => [row.address.path.join("."), row.status])).toEqual([
      ["summaryHeading", "new"],
      ["summaryHeading.few", "new"],
      ["notAWord", "unknown"]
    ]);
    expect(result.newLocales).toEqual(["pl"]);
    expect(result.unknownCount).toBe(1);
  });

  it("names the cells to leave empty in the prompt of a non-English default", () => {
    const prompt = promptText([engine(), field()], ["fr", "en", "es"], "all", { ...HEADER, defaultLocale: "fr" });
    expect(prompt).toContain('The column lang:fr is the form\'s own language: translate only the rows of kind "texts" there');
    expect(prompt).toContain('Rows of kind "texts" are already English: leave their lang:en cell empty.');
    // An English default has neither column to explain.
    expect(promptText([engine(), field()], ["fr"], "all", HEADER)).not.toContain("leave its cell empty");
  });

});
