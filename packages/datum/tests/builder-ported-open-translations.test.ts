import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { DatumWarningDetail } from "../src/support.js";
import { until } from "./helpers.js";

/*
 * The words of the warning a form with unusable translation entries brings: one entry is told in
 * the singular, the first five addresses are named and the rest counted, and a map that is not a
 * map at all is named "translations". (The plural wording and the load itself are in
 * builder-element-translations-dropped.test.ts.)
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const formWith = (translations: unknown) => ({
  id: "t",
  version: "1.0.0",
  schemaVersion: "1",
  localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }] },
  translations,
  root: { id: "root", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] } }
});

async function loaded(translations: unknown): Promise<{ warnings: DatumWarningDetail[]; errors: string[]; element: DatumFormBuilderElement }> {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
  document.body.append(element);
  await until(() => element.controller);
  const warnings: DatumWarningDetail[] = [];
  const errors: string[] = [];
  element.addEventListener("datum-warning", (event) => warnings.push((event as CustomEvent<DatumWarningDetail>).detail));
  element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
  element.definition = formWith(translations) as never;
  await until(() => warnings.length > 0);
  return { warnings, errors, element };
}

describe("the translations.dropped warning's wording", () => {
  it("says \"1 translation entry was\" for a single entry, with its address", async () => {
    const { warnings, errors } = await loaded({ fr: { components: { name: { label: { text: 5, source: "x" } } } } });
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual({
      code: "translations.dropped",
      count: 1,
      addresses: ["fr.components.name.label"],
      message: "The form was loaded, but 1 translation entry was left out as unusable (fr.components.name.label): saving the form keeps only the others."
    });
  });

  it("names the first five addresses and counts the rest: \", and N more\"", async () => {
    // Seven locale entries that are not maps of texts: seven entries left out, five of them named.
    const bad = Object.fromEntries(["a", "b", "c", "d", "e", "f", "g"].map((code) => [code, "not a map"]));
    const { warnings } = await loaded(bad);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.count).toBe(7);
    expect(warnings[0]!.addresses).toEqual(["a", "b", "c", "d", "e"]);
    expect(warnings[0]!.message).toBe(
      "The form was loaded, but 7 translation entries were left out as unusable (a, b, c, d, e, and 2 more): saving the form keeps only the others."
    );
  });

  it("names the address \"translations\" when the whole value is not a map", async () => {
    const { warnings, element } = await loaded("not a map");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.count).toBe(1);
    expect(warnings[0]!.addresses).toEqual(["translations"]);
    expect(warnings[0]!.message).toBe("The form was loaded, but 1 translation entry was left out as unusable (translations): saving the form keeps only the others.");
    // The form itself loaded, with no translations to keep.
    expect(element.definition.id).toBe("t");
    expect(element.controller?.snapshot().children?.content?.map((child) => child.id)).toEqual(["name"]);
  });

  it("adds no \", and N more\" when the count and the addresses agree", async () => {
    const five = Object.fromEntries(["a", "b", "c", "d", "e"].map((code) => [code, "not a map"]));
    const { warnings } = await loaded(five);
    expect(warnings[0]!.count).toBe(5);
    expect(warnings[0]!.message).not.toContain("more");
    expect(warnings[0]!.message).toContain("5 translation entries were left out as unusable (a, b, c, d, e):");
  });
});
