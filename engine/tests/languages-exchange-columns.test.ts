import { describe, expect, it } from "vitest";

import { applyImport, exportCsv, exportJson, exportXliff, previewImport, promptText } from "../form-engine/builder/languages/exchange.js";
import type { ExchangeHeader, ExchangeText } from "../form-engine/builder/languages/exchange.js";
import { LANGUAGES_EXCHANGE_EN } from "../form-engine/builder/languages/languages-exchange-texts-en.js";
import { sourceHash } from "../form-engine/core/localization/translations.js";

/**
 * The exchange files tell a translator where each cell stands (a status per language), name a
 * language column by its `lang:` prefix, and keep a spreadsheet from running a cell as a formula.
 */

const HEADER: ExchangeHeader = { form: "intake", defaultLocale: "en" };

const text = (patch: Partial<ExchangeText> = {}): ExchangeText => ({
  address: { kind: "components", owner: "a", path: ["label"] },
  default: "Name",
  group: "Fields",
  where: "Name",
  texts: {},
  sources: {},
  ...patch
});

/** A form text with a fresh French translation, a stale Spanish one and no German. */
const mixed = (): ExchangeText =>
  text({
    texts: { fr: "Nom", es: "Nombre" },
    sources: { fr: sourceHash("Name"), es: sourceHash("Old name") }
  });

const read = (file: string, texts: readonly ExchangeText[], declared: string[] = ["en", "fr"]) =>
  previewImport({ name: "f", text: file }, texts, declared, { mode: "replace", defaultLocale: "en" });

describe("CSV language columns", () => {
  it("writes each language as lang:<code>, its status beside it", () => {
    const header = exportCsv([mixed()], ["fr", "es", "de"], "all").split("\r\n")[0];
    expect(header).toBe("kind,key,path,where,default,source,lang:fr,status:fr,lang:es,status:es,lang:de,status:de");
  });

  it("writes fresh, stale and missing as the status of the language", () => {
    const row = exportCsv([mixed()], ["fr", "es", "de"], "all").split("\r\n")[1] ?? "";
    expect(row.endsWith(`,Nom,fresh,Nombre,stale,,missing`)).toBe(true);
  });

  it("leaves the status columns out when asked (the assistant's prompt does)", () => {
    expect(exportCsv([mixed()], ["fr"], "all", { status: false }).split("\r\n")[0]).toBe("kind,key,path,where,default,source,lang:fr");
  });

  it("reads a lang: column and ignores the status beside it", () => {
    const file = exportCsv([mixed()], ["fr", "es"], "all");
    const result = read(file, [mixed()], ["en", "fr", "es"]);
    expect(result.problems).toEqual([]);
    expect(result.rows.map((row) => [row.locale, row.status])).toEqual([
      ["fr", "unchanged"],
      ["es", "unchanged"]
    ]);
  });

  it("reads the prefix in any case and with space after the colon", () => {
    const result = read(`kind,key,path,LANG: fr\r\ncomponents,a,label,Nom\r\n`, [text()]);
    expect(result.rows).toMatchObject([{ locale: "fr", text: "Nom", status: "new" }]);
  });

  it("never takes an unprefixed header for a language, and says when no language is left", () => {
    const result = read(`kind,key,path,fr\r\ncomponents,a,label,Nom\r\n`, [text()]);
    expect(result.rows).toEqual([]);
    expect(result.problems.map((problem) => problem.code)).toEqual(["noLanguageColumns"]);
  });

  it("words the problem of a file with no language column", () => {
    expect(LANGUAGES_EXCHANGE_EN["languages.exchange.problem.noLanguageColumns"]).toContain("lang:");
  });

  it("offers the codes id, no and nr as new languages when they are prefixed", () => {
    const result = read(`kind,key,path,lang:id,lang:no,lang:nr\r\ncomponents,a,label,Nama,Navn,Nomi\r\n`, [text()]);
    expect(result.problems).toEqual([]);
    expect(result.newLocales).toEqual(["id", "no", "nr"]);
  });

  it("keeps a JSON key that no language code would be out of the new languages", () => {
    const file = JSON.stringify({ texts: [{ kind: "components", key: "a", path: "label", id: "components/a/label", ref: "R1", url: "u", no: "n", fr: "Nom" }] });
    const result = read(file, [text()]);
    expect(result.newLocales).toEqual([]);
    expect(result.problems.map((problem) => [problem.code, problem.detail])).toEqual([
      ["badLocale", "id"],
      ["badLocale", "ref"],
      ["badLocale", "url"],
      ["badLocale", "no"]
    ]);
    expect(result.rows.map((row) => row.locale)).toEqual(["fr"]);
  });

  it("still takes such a JSON key for a language the form declares", () => {
    const file = JSON.stringify({ texts: [{ kind: "components", key: "a", path: "label", id: "Nama" }] });
    const result = read(file, [text()], ["en", "id"]);
    expect(result.problems).toEqual([]);
    expect(result.rows.map((row) => row.locale)).toEqual(["id"]);
  });

  it("still refuses a prefixed code that is not a language", () => {
    const result = read(`kind,key,path,lang:Notes,lang:fr\r\ncomponents,a,label,x,Nom\r\n`, [text()]);
    expect(result.problems).toEqual([{ code: "badLocale", row: 1, detail: "Notes" }]);
    expect(result.rows.map((row) => row.locale)).toEqual(["fr"]);
  });

  it("names a bare lang: header as it was written, not as an empty code", () => {
    const result = read(`kind,key,path,lang:,lang:fr\r\ncomponents,a,label,x,Nom\r\n`, [text()]);
    expect(result.problems).toEqual([{ code: "badLocale", row: 1, detail: "lang:" }]);
    expect(result.rows.map((row) => row.locale)).toEqual(["fr"]);
  });

  it("ignores a prefixed column for the default language", () => {
    const result = read(`kind,key,path,lang:en,lang:fr\r\ncomponents,a,label,Name,Nom\r\n`, [text()]);
    expect(result.problems.map((problem) => problem.code)).toEqual(["defaultLocaleColumn"]);
  });

  it("asks the assistant to keep the lang: header, and its prompt carries no status column", () => {
    const prompt = promptText([mixed()], ["fr"], "all", HEADER);
    expect(prompt).toContain("kind,key,path,where,default,source,lang:fr");
    expect(prompt).not.toContain("status:");
    expect(prompt).toContain("(lang:fr)");
  });
});

describe("a status for every language in JSON and XLIFF", () => {
  it("adds a status record to each JSON text, and the importer does not take it for a language", () => {
    const file = exportJson([mixed()], ["fr", "es", "de"], "all", HEADER);
    const out = JSON.parse(file) as { texts: Array<Record<string, unknown>> };
    expect(out.texts[0]?.status).toEqual({ fr: "fresh", es: "stale", de: "missing" });
    const result = read(file, [mixed()], ["en", "fr", "es", "de"]);
    expect(result.problems).toEqual([]);
    expect(result.newLocales).toEqual([]);
  });

  it("states a missing translation as initial, a fresh one as translated and a stale one as translated with the datum:stale subState", () => {
    const segments = (locale: string): string[] =>
      [...exportXliff([mixed()], locale, "all", HEADER).matchAll(/<segment ([^>]*)>/g)].map((match) => match[1] as string);
    expect(segments("fr")).toEqual(['state="translated"']);
    expect(segments("es")).toEqual(['state="translated" subState="datum:stale"']);
    expect(segments("de")).toEqual(['state="initial"']);
  });

  it("uses only the states XLIFF 2.0 allows", () => {
    for (const locale of ["fr", "es", "de"]) {
      for (const match of exportXliff([mixed()], locale, "all", HEADER).matchAll(/state="([^"]+)"/g)) {
        expect(["initial", "translated", "reviewed", "final"]).toContain(match[1]);
      }
    }
  });

  it("reads an XLIFF file back whatever states it carries, and takes no meaning from them", () => {
    for (const locale of ["fr", "es"]) {
      const file = exportXliff([mixed()], locale, "all", HEADER);
      const result = read(file, [mixed()], ["en", "fr", "es"]);
      expect(result.problems).toEqual([]);
      expect(result.rows.map((row) => row.status)).toEqual(["unchanged"]);
    }
  });
});

describe("a spreadsheet does not run a cell", () => {
  const LEADS = ["=HYPERLINK(\"http://x\",\"a\")", "+1 800 555 0100", "-5 degrees", "@SUM(1)", "\tindented", "'=quoted", "''@twice"];

  it("puts an apostrophe before a cell that leads with = + - @ or a tab", () => {
    const file = exportCsv([text({ default: "=SUM(1)", where: "+where", texts: { fr: "@Nom" }, sources: { fr: sourceHash("=SUM(1)") } })], ["fr"], "all");
    const row = file.split("\r\n")[1] ?? "";
    expect(row).toContain(",'+where,'=SUM(1),");
    expect(row).toContain(",'@Nom,");
    expect(row.startsWith("components,a,label,")).toBe(true);
  });

  it("leaves a cell that does not lead with one alone", () => {
    const row = exportCsv([text({ default: "Name = x", texts: { fr: "Nom - x" } })], ["fr"], "all").split("\r\n")[1] ?? "";
    expect(row).toContain(",Name = x,");
    expect(row).toContain(",Nom - x,");
  });

  it("strips the apostrophe on import, so every text comes back as it went out", () => {
    for (const lead of LEADS) {
      const row = text({ texts: { fr: lead } , sources: { fr: sourceHash("Name") } });
      const result = read(exportCsv([row], ["fr"], "all"), [row]);
      expect(result.rows[0]?.text, JSON.stringify(lead)).toBe(lead.trim());
      expect(result.rows[0]?.status, JSON.stringify(lead)).toBe("unchanged");
    }
  });

  it("reads a French translation that leads with a formula character as a new text", () => {
    const result = read(`kind,key,path,lang:fr\r\ncomponents,a,label,'=1+1\r\n`, [text()]);
    expect(applyImport(result, { addLocales: [], mode: "replace" }).edits).toMatchObject([{ locale: "fr", text: "=1+1" }]);
  });

  it("leaves an apostrophe that guards nothing", () => {
    const result = read(`kind,key,path,lang:fr\r\ncomponents,a,label,'Bonjour\r\n`, [text()]);
    expect(result.rows[0]?.text).toBe("'Bonjour");
  });
});
