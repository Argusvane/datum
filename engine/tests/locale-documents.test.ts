import { describe, expect, it } from "vitest";

import { carryChange, carryLocalization } from "../form-engine/core/localization/locale-documents.js";

// These cover what locale-documents.ts keeps. The data is plain JSON; the merge does not care what it means.
describe("carryChange", () => {
  const before = { journeys: [{ id: "a", info: { name: "Start", extra: { fr: "Début" } }, note: "x" }] };
  const after = { journeys: [{ id: "a", info: { name: "Start" }, note: "x" }] };

  it("puts back what a change took where nothing has changed since", () => {
    expect(carryChange(after, after, before)).toEqual(before);
    expect(carryChange(before, before, after)).toEqual(after);
  });

  it("keeps what was edited since: only the change's own parts go back", () => {
    const edited = { journeys: [{ id: "a", info: { name: "Start" }, note: "edited since" }] };
    expect(carryChange(edited, after, before)).toEqual({ journeys: [{ id: "a", info: { name: "Start", extra: { fr: "Début" } }, note: "edited since" }] });
    // A value edited since is left as it is rather than overwritten by the one restored.
    const renamed = { journeys: [{ id: "a", info: { name: "Begin" }, note: "x" }] };
    expect(carryChange(renamed, after, before)).toEqual({ journeys: [{ id: "a", info: { name: "Begin", extra: { fr: "Début" } }, note: "x" }] });
  });
});

describe("carryChange across lists", () => {
  const journey = (id: string, fr?: string) => ({ id, info: fr ? { name: id, extra: { fr } } : { name: id }, pages: [{ id: `${id}-p`, info: fr ? { name: "P", extra: { fr: `${fr}!` } } : { name: "P" } }] });

  it("matches entries by id, so an entry added since is left alone and the others still get the change", () => {
    const before = { journeys: [journey("a", "Début")] };
    const after = { journeys: [journey("a")] };
    const current = { journeys: [journey("a"), journey("b")] };
    expect(carryChange(current, after, before)).toEqual({ journeys: [journey("a", "Début"), journey("b")] });
  });

  it("matches by id when entries were moved or one was removed since, pages included", () => {
    const before = { journeys: [journey("a", "Début"), journey("c", "Fin")] };
    const after = { journeys: [journey("a"), journey("c")] };
    const current = { journeys: [journey("c"), journey("a")] };
    expect(carryChange(current, after, before)).toEqual({ journeys: [journey("c", "Fin"), journey("a", "Début")] });
    expect(carryChange({ journeys: [journey("c")] }, after, before)).toEqual({ journeys: [journey("c", "Fin")] });
  });

  it("falls back to position for a list without ids, only while its length is unchanged", () => {
    expect(carryChange(["x"], ["x"], ["y"])).toEqual(["y"]);
    expect(carryChange([{ v: 1 }, { v: 2 }], [{ v: 1 }], [{ v: 3 }])).toEqual([{ v: 1 }, { v: 2 }]);
  });
});

describe("carryLocalization", () => {
  const entries = (...codes: string[]) => ({ supportedLocales: codes.map((code) => ({ code })), defaultLocale: "en" });
  const codesOf = (value: ReturnType<typeof carryLocalization>) => (value?.supportedLocales ?? []).map((entry) => (typeof entry === "string" ? entry : entry.code));

  it("re-adds a removed language after the nearest earlier one, keeping languages added since", () => {
    expect(codesOf(carryLocalization(entries("en", "de", "es"), entries("en", "de"), entries("en", "fr", "de")))).toEqual(["en", "fr", "de", "es"]);
    expect(codesOf(carryLocalization(entries("en"), entries("en"), entries("fr", "en")))).toEqual(["fr", "en"]);
  });

  it("takes out what the change gave, and moves the default only where the author has not", () => {
    expect(codesOf(carryLocalization(entries("en", "fr-CA", "es"), entries("en", "fr-CA"), entries("en", "fr")))).toEqual(["en", "fr", "es"]);
    const moved = carryLocalization({ ...entries("en", "fr"), defaultLocale: "de" }, { ...entries("en", "fr"), defaultLocale: "fr" }, entries("en", "fr"));
    expect(moved?.defaultLocale).toBe("de");
  });
});
