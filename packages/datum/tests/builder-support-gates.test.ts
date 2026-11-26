import { describe, expect, it } from "vitest";
import { kernelStructureLocaleMax } from "@argusvane/datum-engine";

import { chromePartProblem, definitionTreeProblem, formDefinitionProblem, journeyConfigurationProblem, pdfConfigurationProblem } from "../src/support.js";

const form = (configuration: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): any => ({
  id: "f",
  version: "1.0.0",
  schemaVersion: "1",
  ...extra,
  root: { id: "root", type: "form", configuration, children: { content: [] } }
});

describe("the side blocks a setter takes as a whole", () => {
  it("reads null as dropping the side, as undefined does, not as a shape to refuse", () => {
    expect(journeyConfigurationProblem(form(), null)).toBeUndefined();
    expect(pdfConfigurationProblem(form(), null)).toBeUndefined();
    expect(journeyConfigurationProblem(form(), 5)).toBe("journey must be an object");
    expect(pdfConfigurationProblem(form(), 5)).toBe("pdf must be an object");
  });
});

describe("Open's language codes", () => {
  it("refuses a code longer than the server reads, in the list and as the default", () => {
    const long = `en-${"a".repeat(kernelStructureLocaleMax())}`;
    expect(formDefinitionProblem(form({}, { localization: { supportedLocales: [{ code: "en" }, { code: long }] } }))).toMatch(/supportedLocales\[1\].*longer than/);
    expect(formDefinitionProblem(form({}, { localization: { supportedLocales: [{ code: long }] } }))).toMatch(/supportedLocales\[0\].*longer than/);
    expect(formDefinitionProblem(form({}, { localization: { defaultLocale: long } }))).toMatch(/defaultLocale.*longer than/);
    const fits = `en-${"a".repeat(kernelStructureLocaleMax() - 3)}`;
    expect(formDefinitionProblem(form({}, { localization: { supportedLocales: [{ code: "en" }, { code: fits }], defaultLocale: fits } }))).toBeUndefined();
  });
});

describe("chrome part ids at load", () => {
  const chrome = (header: unknown[], footer: unknown[] = []) => form({ chrome: { header, footer } });
  const part = (id: string | undefined, text = "Hello") => ({ ...(id === undefined ? {} : { id }), type: "text", text });

  it("names a part with no id, an unsafe id and a repeated id, and says nothing of a good chrome", () => {
    expect(chromePartProblem(chrome([part("welcome")], [part("privacy")]))).toBeUndefined();
    expect(chromePartProblem(form())).toBeUndefined();
    expect(chromePartProblem(chrome([part(undefined)]))).toMatch(/header part 1 has no id/);
    expect(chromePartProblem(chrome([part("welcome"), { type: "group", id: "row", parts: [part(undefined)] }]))).toMatch(/header part 2\.1 has no id/);
    expect(chromePartProblem(chrome([part("__proto__")]))).toMatch(/header part 1.*__proto__/);
    expect(chromePartProblem(chrome([part("same")], [part("same")]))).toMatch(/header part 1.*"same".*more than one/);
  });

  it("is no reason to refuse the form: Open and the tree gate both take it, the canvas draws the part untranslated", () => {
    expect(formDefinitionProblem(chrome([part(undefined)]))).toBeUndefined();
    expect(definitionTreeProblem(chrome([part(undefined)]))).toBeUndefined();
  });
});
