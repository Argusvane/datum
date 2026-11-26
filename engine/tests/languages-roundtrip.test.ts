import { describe, expect, it } from "vitest";

import { exportCsv, exportJson, exportXliff, previewImport } from "../form-engine/builder/languages/exchange.js";
import type { ExchangeText } from "../form-engine/builder/languages/exchange.js";
import { addressOf, sourceHash } from "../form-engine/core/localization/translations.js";

let seed = 99;
const rnd = (n: number): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const ALPHA = ["a", "é", '"', ",", ";", "\t", "\r", "\n", " ", "<", "&", ">", "'", "😀", "\u000b", "%", "/", "=", "﻿", "z"];
const word = (): string => Array.from({ length: 1 + rnd(8) }, () => ALPHA[rnd(ALPHA.length)]).join("");

type Format = "csv" | "json" | "xliff";

function exported(format: Format, text: ExchangeText): string {
  const header = { defaultLocale: "en" };
  if (format === "csv") {
    return exportCsv([text], ["fr"], "all");
  }
  return format === "json" ? exportJson([text], ["fr"], "all", header) : exportXliff([text], "fr", "all", header);
}

// The words an import hands back: without the space around them, and in a CSV cell a line end is one `\n`.
const wording = (format: Format, translation: string): string => (format === "csv" ? translation.replace(/\r\n?/g, "\n") : translation).trim();

describe("every format gives a translation and its fingerprint back", () => {
  it("a seeded run of odd texts, new and unchanged", () => {
    const bad: string[] = [];
    for (let round = 0; round < 300; round += 1) {
      const def = word();
      const owner = `c${rnd(5)}`;
      const translation = word();
      const base: ExchangeText = { address: addressOf.option(owner, word().replace(/\u0000/g, "") || "v", "label"), default: def, group: "options", where: word(), texts: {}, sources: {} };
      const withFrench: ExchangeText = { ...base, texts: { fr: translation }, sources: { fr: sourceHash(def) } };
      for (const format of ["csv", "json", "xliff"] as const) {
        if (translation.trim() === "" || (format === "xliff" && def === "")) {
          continue;
        }
        const file = exported(format, withFrench);
        const fresh = previewImport({ name: "f", text: file }, [base], ["fr"], { mode: "replace", defaultLocale: "en" }).rows[0];
        // The form already holds that very text: the file's own export is no change.
        const same = previewImport({ name: "f", text: file }, [withFrench], ["fr"], { mode: "replace", defaultLocale: "en" });
        const row = same.rows[0];
        const label = `${format} def=${JSON.stringify(def)} tr=${JSON.stringify(translation)}`;
        if (fresh?.text !== wording(format, translation) || fresh.stale || row?.stale || row?.status !== "unchanged" || same.problems.length > 0) {
          bad.push(`${label} got=${JSON.stringify(fresh?.text)} stale=${fresh?.stale}/${row?.stale} status=${row?.status} problems=${JSON.stringify(same.problems)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("a carriage return in a text", () => {
  const text: ExchangeText = { address: addressOf.component("a", "label"), default: "A\rB", group: "Fields", where: "a", texts: { fr: "x\ry\r\nz" }, sources: { fr: sourceHash("A\rB") } };
  const bare: ExchangeText = { ...text, texts: {}, sources: {} };

  it("is written to an XLIFF as a reference, so the reader gets it back", () => {
    const file = exportXliff([text], "fr", "all", { defaultLocale: "en" });
    expect(file).not.toContain("\r");
    expect(file).toContain("&#13;");
    const row = previewImport({ name: "f.xlf", text: file }, [bare], ["fr"], { mode: "replace", defaultLocale: "en" }).rows[0];
    expect(row?.text).toBe("x\ry\r\nz");
    expect(row?.stale).toBe(false);
  });

  it("does not make an unchanged CSV row look changed", () => {
    const file = exportCsv([text], ["fr"], "all");
    const preview = previewImport({ name: "f.csv", text: file }, [text], ["fr"], { mode: "replace", defaultLocale: "en" });
    expect(preview.rows[0]?.status).toBe("unchanged");
    expect(preview.rows[0]?.stale).toBe(false);
  });

  it("an XLIFF written with raw carriage returns is not stale for the line ends alone", () => {
    const raw = `<?xml version="1.0"?><xliff version="2.0" srcLang="en" trgLang="fr" xmlns="urn:oasis:names:tc:xliff:document:2.0"><file id="f"><unit id="components/a/label"><segment><source>A\rB</source><target>Salut</target></segment></unit></file></xliff>`;
    expect(previewImport({ name: "old.xlf", text: raw }, [bare], ["fr"], { mode: "replace", defaultLocale: "en" }).rows[0]?.stale).toBe(false);
  });
});
