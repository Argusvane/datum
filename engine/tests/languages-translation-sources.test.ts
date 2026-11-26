import { describe, expect, it } from "vitest";

import { addressOf, isStale, makeDefaultLocale, readTranslation, sourceHash, STALE_SOURCE, writeTranslation, writeTranslationEntry } from "../form-engine/core/localization/translations.js";
import type { FormTranslations } from "../form-engine/core/localization/translations.js";

const at = addressOf.component("name", "label");

describe("an entry whose source is not a fingerprint", () => {
  it("is kept as a stale marker when it is moved, never refused", () => {
    const long = "z".repeat(5_000);
    const hostile = { fr: { components: { name: { label: { text: "Nom", source: long } } } } } as unknown as FormTranslations;
    const kept = writeTranslationEntry(undefined, "fr", at, readTranslation(hostile, "fr", at) as { text: string; source: string });
    expect(readTranslation(kept, "fr", at)).toEqual({ text: "Nom", source: STALE_SOURCE });
    expect(isStale(readTranslation(kept, "fr", at) as { text: string; source: string }, "Name")).toBe(true);
    expect(isStale({ text: "x", source: STALE_SOURCE }, "")).toBe(true);
  });

  it("survives Make default: the demoted default keeps the promoted entry's marker", () => {
    const start = { fr: { components: { name: { label: { text: "Nom", source: "not a fingerprint!" } } } } } as unknown as FormTranslations;
    const { translations, defaults } = makeDefaultLocale(start, [{ address: at, default: "Name" }], "en", "fr");
    expect(defaults[0]?.default).toBe("Nom");
    // The promoted text answered other wording than "Name", so the old default comes back as it
    // was, flagged, rather than as a fresh translation.
    expect(readTranslation(translations, "en", at)).toEqual({ text: "Name", source: STALE_SOURCE });
    expect(readTranslation(translations, "fr", at)).toBeUndefined();
  });

  it("is not made current by a write that carries it with the text", () => {
    const entry = writeTranslationEntry(undefined, "fr", at, { text: "Nom", source: "?" });
    expect(isStale(readTranslation(entry, "fr", at) as { text: string; source: string }, "Name")).toBe(true);
  });
});

describe("the text a translation writer stores", () => {
  it("keeps the whitespace the author wrote, and a Make default round trip returns the default untouched", () => {
    const padded = "  Name \n";
    const start = writeTranslation(undefined, "fr", at, " Nom ", padded);
    expect(readTranslation(start, "fr", at)?.text).toBe(" Nom ");
    const there = makeDefaultLocale(start, [{ address: at, default: padded }], "en", "fr");
    expect(there.defaults[0]?.default).toBe(" Nom ");
    const back = makeDefaultLocale(there.translations, there.defaults, "fr", "en");
    expect(back.defaults[0]?.default).toBe(padded);
    expect(readTranslation(back.translations, "fr", at)).toEqual({ text: " Nom ", source: sourceHash(padded) });
  });

  it("still takes a blank text for no translation", () => {
    const start = writeTranslation(undefined, "fr", at, "Nom", "Name");
    expect(writeTranslation(start, "fr", at, " \t", "Name")).toEqual({});
  });
});
