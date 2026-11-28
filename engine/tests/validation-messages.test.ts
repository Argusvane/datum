import { describe, expect, it } from "vitest";

import { sourceHash, type FormTranslations } from "../form-engine/core/localization/translations.js";
import {
  DEFAULT_VALIDATION_MESSAGES,
  defaultValidationMessage,
  ENGINE_VALIDATION_CODES,
  layerValidationMessages,
  parseValidationMessageCatalog,
  readValidationMessages,
  resolveValidationMessage
} from "../form-engine/core/localization/validation-messages.js";

/** The engine's French messages as a form's `texts` translations would hold them (the engine words only English). */
const FRENCH_MESSAGES: Record<string, string> = {
  required: "Ce champ est obligatoire",
  maxLength: "Saisissez au plus {maxLength} caractères",
  number: "Saisissez un nombre",
  "rows.min": "Trop peu de lignes : ajoutez-en au moins {min}.",
  "rows.max": "Trop de lignes : au plus {max}."
};

function messagesIn(locale: string, words: Record<string, string>): FormTranslations {
  const messages = Object.fromEntries(Object.entries(words).map(([code, text]) => [code, { text, source: sourceHash(DEFAULT_VALIDATION_MESSAGES[code] ?? "") }]));
  return { [locale]: { texts: { messages } } };
}

const FR_WORDS = { translations: messagesIn("fr", FRENCH_MESSAGES) };

describe("resolveValidationMessage", () => {
  it("falls back to the error's own message when no catalog is supplied", () => {
    expect(resolveValidationMessage({ code: "required", message: "Field is required" }, undefined, "en")).toBe(
      "Field is required"
    );
  });

  it("falls back to the bare code only for a code nothing words, with no message and no catalog", () => {
    // `required` has a built-in sentence, so only a code the
    // engine has no wording for (a plugin's, a server's) can still reach a person as itself.
    expect(resolveValidationMessage({ code: "required" }, undefined, "en")).toBe(DEFAULT_VALIDATION_MESSAGES.required);
    expect(resolveValidationMessage({ code: "plugin.custom" }, undefined, "en")).toBe("plugin.custom");
  });

  it("prefers a localized catalog entry for the error's code", () => {
    const catalog = { required: { default: "This field is required", locales: { fr: "Ce champ est requis" } } };
    expect(resolveValidationMessage({ code: "required", message: "raw" }, catalog, "fr")).toBe(
      "Ce champ est requis"
    );
    expect(resolveValidationMessage({ code: "required", message: "raw" }, catalog, "en")).toBe(
      "This field is required"
    );
  });

  it("fills {parameter} tokens from the error's parameters", () => {
    const catalog = {
      minLength: {
        default: "Use at least {minLength} characters ({length} so far)",
        locales: { fr: "Au moins {minLength} caractères" }
      }
    };
    const error = { code: "minLength", parameters: { minLength: 5, length: 2 } };
    expect(resolveValidationMessage(error, catalog, "en")).toBe("Use at least 5 characters (2 so far)");
    expect(resolveValidationMessage(error, catalog, "fr")).toBe("Au moins 5 caractères");
    // The raw message interpolates too; a token naming nothing scalar stays as authored.
    expect(
      resolveValidationMessage(
        { code: "x", message: "{a} {b} {c}", parameters: { a: "1", b: { nested: true } } },
        undefined,
        "en"
      )
    ).toBe("1 {b} {c}");
  });

  it("falls through to the raw message when the catalog has no entry for the code", () => {
    const catalog = { other: "Something else" };
    expect(resolveValidationMessage({ code: "required", message: "raw message" }, catalog, "en")).toBe(
      "raw message"
    );
  });

  it("reads a host's entry from its own words only: a host text has no address in a map", () => {
    const catalog = { required: { default: "Required", locales: { "fr-CA": "Obligatoire" } } };
    expect(resolveValidationMessage({ code: "required" }, catalog, "fr-CA")).toBe("Obligatoire");
    expect(resolveValidationMessage({ code: "required" }, catalog, "fr")).toBe("Required");
  });
});

describe("parseValidationMessageCatalog", () => {
  it("keeps the entries that are text and drops the rest", () => {
    expect(
      parseValidationMessageCatalog({
        required: "Required",
        minLength: { default: "Too short", locales: { fr: "Trop court" } },
        pattern: 42,
        fileType: null,
        "": "no code",
        nested: { not: "text" }
      })
    ).toEqual({ required: "Required", minLength: { default: "Too short", locales: { fr: "Trop court" } } });
  });

  it("is undefined for anything that is not a map, or a map with nothing usable", () => {
    expect(parseValidationMessageCatalog(undefined)).toBeUndefined();
    expect(parseValidationMessageCatalog("required")).toBeUndefined();
    expect(parseValidationMessageCatalog(["required"])).toBeUndefined();
    expect(parseValidationMessageCatalog({})).toBeUndefined();
    expect(parseValidationMessageCatalog({ required: 1 })).toBeUndefined();
  });
});

describe("readValidationMessages", () => {
  it("reads a component's messages map", () => {
    expect(
      readValidationMessages({
        label: "Email",
        messages: { required: "Enter your email.", pattern: "Not an email" }
      })
    ).toEqual({ required: "Enter your email.", pattern: "Not an email" });
  });

  it("keeps only strings from a component: a LocalizedText there is not a message", () => {
    expect(readValidationMessages({ messages: { required: { default: "Required", locales: { fr: "Requis" } }, pattern: "Bad" } })).toEqual({
      pattern: "Bad"
    });
    expect(readValidationMessages({ patternMessage: { default: "Use A1A 1A1" } })).toBeUndefined();
  });

  it("words each message for a locale at its owner's address, the form's own at the form's", () => {
    const translations = {
      "fr-CA": {
        form: { messages: { required: { text: "Requis (formulaire)", source: "x" } } },
        components: {
          email: {
            messages: { required: { text: "Entrez votre courriel.", source: "x" } },
            patternMessage: { text: "Pas un courriel", source: "x" }
          }
        }
      }
    };
    const field = { messages: { required: "Enter your email." }, patternMessage: "Not an email" };
    expect(readValidationMessages(field, { ownerId: "email", locale: "fr", sources: { translations } })).toEqual({
      required: "Enter your email.",
      pattern: "Not an email"
    });
    expect(readValidationMessages(field, { ownerId: "email", locale: "fr-CA", sources: { translations } })).toEqual({
      required: "Entrez votre courriel.",
      pattern: "Pas un courriel"
    });
    // The form root has no owner: `form › messages › <code>`.
    expect(readValidationMessages({ messages: { required: "Required" } }, { locale: "fr-CA", sources: { translations } })).toEqual({
      required: "Requis (formulaire)"
    });
    // The host's catalog wins over the map for the same address; other owners' entries are not read.
    const catalog = { "fr-CA": { components: { email: { messages: { required: "Courriel obligatoire" } } } } };
    expect(readValidationMessages(field, { ownerId: "email", locale: "fr-CA", sources: { translations, catalog } })?.required).toBe(
      "Courriel obligatoire"
    );
    expect(readValidationMessages(field, { ownerId: "phone", locale: "fr-CA", sources: { translations } })?.required).toBe("Enter your email.");
  });

  it("lets patternMessage stand in for a pattern entry the map lacks, and no further", () => {
    expect(readValidationMessages({ patternMessage: "Use A1A 1A1" })).toEqual({
      pattern: "Use A1A 1A1"
    });
    // An explicit entry outranks the older field.
    expect(
      readValidationMessages({ patternMessage: "old", messages: { pattern: "new", required: "Required" } })
    ).toEqual({ pattern: "new", required: "Required" });
  });

  it("is undefined for a configuration that authors nothing usable", () => {
    expect(readValidationMessages(undefined)).toBeUndefined();
    expect(readValidationMessages({ label: "Name" })).toBeUndefined();
    expect(readValidationMessages({ messages: {} })).toBeUndefined();
    expect(readValidationMessages({ messages: "Required", patternMessage: 3 })).toBeUndefined();
  });
});

describe("layerValidationMessages", () => {
  it("lets the earlier catalog win per code and the later ones fill the gaps", () => {
    const field = { required: "Field says" };
    const form = { required: "Form says", minLength: "Form: too short" };
    const host = { required: "Host says", minLength: "Host: too short", maxLength: "Host: too long" };
    expect(layerValidationMessages(field, form, host)).toEqual({
      required: "Field says",
      minLength: "Form: too short",
      maxLength: "Host: too long"
    });
    // The order is the precedence: the same catalogs the other way round.
    expect(layerValidationMessages(host, form, field)).toEqual(host);
  });

  it("skips absent catalogs and is undefined when none had an entry", () => {
    expect(layerValidationMessages(undefined, { required: "x" }, undefined)).toEqual({ required: "x" });
    expect(layerValidationMessages()).toBeUndefined();
    expect(layerValidationMessages(undefined, undefined)).toBeUndefined();
    expect(layerValidationMessages({}, undefined)).toBeUndefined();
  });

  it("never hands back one of its inputs, so a caller may add to the result", () => {
    const only = { required: "x" };
    const layered = layerValidationMessages(only);
    expect(layered).toEqual(only);
    expect(layered).not.toBe(only);
  });
});

describe("a field limit raised with no parameters and no message", () => {
  it("reads a token-free sentence, never a template with unfilled tokens", () => {
    expect(resolveValidationMessage({ code: "minLength" }, undefined, "en")).toBe("This answer is too short");
    expect(resolveValidationMessage({ code: "maxFileSize" }, undefined, "fr-CA")).toBe("This file is too large for this field");
    for (const code of ["minLength", "maxLength", "fileType", "maxFileSize"]) {
      expect(resolveValidationMessage({ code }, undefined, "en")).not.toMatch(/\{\w+\}/);
    }
    // With its parameters the built-in sentence is filled as before.
    expect(resolveValidationMessage({ code: "minLength", parameters: { minLength: 5, length: 2 } }, undefined, "en")).toContain("5");
  });
});

describe("ENGINE_VALIDATION_CODES", () => {
  it("names the codes the field-constraints stage raises, with the details each carries", () => {
    expect(ENGINE_VALIDATION_CODES.map((entry) => entry.code)).toEqual([
      "required",
      "minLength",
      "maxLength",
      "pattern",
      "fileType",
      "maxFileSize",
      "fileSize",
      "file.sizeMismatch",
      "file",
      "fileCount",
      "text",
      "number",
      "number.min",
      "number.max",
      "date",
      "date.min",
      "date.max",
      "dateIncomplete",
      "date.year",
      // The field's Validate rule.
      "rule",
      // A data grid's row count.
      "rows.min",
      "rows.max"
    ]);
    const parameters = Object.fromEntries(ENGINE_VALIDATION_CODES.map((entry) => [entry.code, entry.parameters]));
    expect(parameters).toEqual({
      required: [],
      minLength: ["minLength", "length"],
      maxLength: ["maxLength", "length"],
      pattern: ["pattern"],
      fileType: ["file", "type", "accept"],
      maxFileSize: ["file", "sizeLabel", "maxFileSizeLabel", "size", "maxFileSize"],
      fileSize: ["file", "size"],
      "file.sizeMismatch": ["file", "size", "actual"],
      file: [],
      fileCount: ["count", "maxFiles"],
      text: [],
      number: [],
      "number.min": ["min"],
      "number.max": ["max"],
      date: [],
      "date.min": ["min"],
      "date.max": ["max"],
      dateIncomplete: ["missing", "missingKey"],
      "date.year": [],
      rule: [],
      "rows.min": ["min", "count"],
      "rows.max": ["max", "count"]
    });
    for (const entry of ENGINE_VALIDATION_CODES) {
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });
});

describe("DEFAULT_VALIDATION_MESSAGES", () => {
  it("words every code with a built-in sentence, and fileSize, so none renders bare", () => {
    for (const code of ["text", "file", "fileCount", "fileSize", "file.sizeMismatch", "number.min", "number.max", "date.min", "date.max", "option.sourceUnavailable", "option.notAllowed"]) {
      expect(DEFAULT_VALIDATION_MESSAGES[code], code).toBeTypeOf("string");
      expect(resolveValidationMessage({ code }, undefined, "en"), code).not.toBe(code);
    }
  });

  it("quotes the bound and the count from the error's parameters", () => {
    expect(resolveValidationMessage({ code: "number.min", parameters: { min: 18 } }, undefined, "en")).toBe("Enter a number of 18 or more");
    expect(resolveValidationMessage({ code: "number.max", parameters: { max: 120 } }, undefined, "en")).toBe("Enter a number of 120 or less");
    expect(resolveValidationMessage({ code: "date.min", parameters: { min: "2024-01-01" } }, undefined, "en")).toBe("Enter a date on or after 2024-01-01");
    expect(resolveValidationMessage({ code: "date.max", parameters: { max: "2024-12-31" } }, undefined, "en")).toBe("Enter a date on or before 2024-12-31");
    expect(resolveValidationMessage({ code: "fileCount", parameters: { count: 3, maxFiles: 1 } }, undefined, "en")).toBe("Too many files: the most allowed is 1");
  });

  it("words a data grid's row count with no plural to agree with the bound, in English and in a translation", () => {
    // "Add at least 1 rows." read wrong for a bound of one: the bound stands alone after the colon.
    expect(resolveValidationMessage({ code: "rows.min", parameters: { min: 1, count: 0 } }, undefined, "en")).toBe("Too few rows: add at least 1.");
    expect(resolveValidationMessage({ code: "rows.max", parameters: { max: 1, count: 2 } }, undefined, "en")).toBe("Too many rows: at most 1.");
    expect(resolveValidationMessage({ code: "rows.min", parameters: { min: 3, count: 1 } }, undefined, "fr", FR_WORDS)).toBe("Trop peu de lignes : ajoutez-en au moins 3.");
    expect(resolveValidationMessage({ code: "rows.max", parameters: { max: 1, count: 2 } }, undefined, "fr", FR_WORDS)).toBe("Trop de lignes : au plus 1.");
  });

  it("is overridden by a catalog entry, as any default is", () => {
    expect(resolveValidationMessage({ code: "number.max", parameters: { max: 5 } }, { "number.max": "At most {max}." }, "en")).toBe("At most 5.");
  });

  it("words an engine-owned code with the engine's text over a baked message, an authored entry over both", () => {
    // A baked message in any language gives way to the engine's sentence in the form's locale:
    // the form's `texts` translation of it, else the English.
    expect(resolveValidationMessage({ code: "number", message: "Entrez un nombre (baked)" }, undefined, "fr", FR_WORDS)).toBe("Saisissez un nombre");
    expect(resolveValidationMessage({ code: "number", message: "Entrez un nombre (baked)" }, undefined, "fr")).toBe(DEFAULT_VALIDATION_MESSAGES.number);
    expect(resolveValidationMessage({ code: "number", message: "baked" }, undefined, "en")).toBe(DEFAULT_VALIDATION_MESSAGES.number);
    expect(
      resolveValidationMessage({ code: "number", message: "baked" }, { number: { default: "A", locales: { fr: "Un nombre" } } }, "fr")
    ).toBe("Un nombre");
    // An engine code with no engine wording (required) still shows the raiser's message.
    expect(resolveValidationMessage({ code: "required", message: "baked" }, undefined, "en")).toBe("baked");
    // A non-engine code keeps its message before any engine text.
    expect(resolveValidationMessage({ code: "journey.exit", message: "Server says no" }, undefined, "en")).toBe("Server says no");
  });

  it("words every code the engine raises, with tokens its parameters fill", () => {
    const codes = new Set([...ENGINE_VALIDATION_CODES.map((entry) => entry.code), ...Object.keys(DEFAULT_VALIDATION_MESSAGES)]);
    for (const code of codes) {
      expect(defaultValidationMessage(code, "en"), `${code} (en)`).toBeTypeOf("string");
      // English only: another language reads the English until the form translates it.
      expect(defaultValidationMessage(code, "fr-CA"), `${code} (fr)`).toBe(defaultValidationMessage(code, "en"));
      // Whatever parameters the builder says the code carries fill every token: nothing renders a hole.
      const described = ENGINE_VALIDATION_CODES.find((entry) => entry.code === code);
      const parameters = Object.fromEntries((described?.parameters ?? ["min", "max", "maxFiles"]).map((name) => [name, "7"]));
      for (const locale of ["en", "fr"]) {
        const sentence = resolveValidationMessage({ code, parameters }, undefined, locale);
        expect(sentence, `${code} ${locale}`).not.toBe(code);
        expect(sentence, `${code} ${locale}`).not.toMatch(/\{\w+\}/);
      }
    }
  });

  it("reads the engine's sentence from the form's `texts` translations, the host catalog's over them, then a language pack", () => {
    expect(defaultValidationMessage("required", "fr-CA", FR_WORDS)).toBe("Ce champ est obligatoire");
    expect(defaultValidationMessage("date", "fr", FR_WORDS)).toBe(DEFAULT_VALIDATION_MESSAGES.date);
    const catalog = { fr: { texts: { messages: { required: "Requis (hôte)" } } } };
    expect(defaultValidationMessage("required", "fr", { ...FR_WORDS, catalog })).toBe("Requis (hôte)");
    const pack = { messages: { fr: { required: "Obligatoire (pack)", date: "Date réelle (pack)" } } };
    expect(defaultValidationMessage("required", "fr", { ...FR_WORDS, pack })).toBe("Ce champ est obligatoire");
    expect(defaultValidationMessage("date", "fr-CA", { pack })).toBe("Date réelle (pack)");
    expect(defaultValidationMessage("date", "en", { pack })).toBe(DEFAULT_VALIDATION_MESSAGES.date);
    expect(defaultValidationMessage("plugin.custom", "fr", { pack: { messages: { fr: { "plugin.custom": "x" } } } })).toBeUndefined();
  });

  it("never lets a core code reach a person bare, in any locale, with no catalog and no message", () => {
    for (const { code } of ENGINE_VALIDATION_CODES) {
      for (const locale of ["en", "en-CA", "fr", "fr-CA", "es"]) {
        expect(resolveValidationMessage({ code }, undefined, locale), `${code} ${locale}`).not.toBe(code);
      }
    }
  });

  it("words required, the length limits, pattern and the file limits in the person's language", () => {
    expect(resolveValidationMessage({ code: "required" }, undefined, "fr-CA", FR_WORDS)).toBe("Ce champ est obligatoire");
    expect(resolveValidationMessage({ code: "minLength", parameters: { minLength: 5, length: 2 } }, undefined, "en")).toBe("Enter at least 5 characters");
    expect(resolveValidationMessage({ code: "maxLength", parameters: { maxLength: 3, length: 9 } }, undefined, "fr", FR_WORDS)).toBe("Saisissez au plus 3 caractères");
    expect(resolveValidationMessage({ code: "maxFileSize", parameters: { file: "a.pdf", maxFileSizeLabel: "5 MB" } }, undefined, "en")).toContain("a.pdf is larger than the 5 MB");
  });

  it("keeps the precedence field over form over built-in, and a carried message over the built-in", () => {
    const form = layerValidationMessages({ required: "Field says" }, { required: "Form says", pattern: "Form pattern" });
    expect(resolveValidationMessage({ code: "required" }, form, "en")).toBe("Field says");
    expect(resolveValidationMessage({ code: "pattern" }, form, "en")).toBe("Form pattern");
    // The author's own pattern message travels on the error and outranks the sentence.
    expect(resolveValidationMessage({ code: "pattern", message: "Use A1A 1A1" }, undefined, "en")).toBe("Use A1A 1A1");
  });

  it("reads the raiser's message when the engine's wording has tokens the error has no parameters for", () => {
    expect(resolveValidationMessage({ code: "number.max", message: "Most you can claim is 100" }, undefined, "en")).toBe("Most you can claim is 100");
    expect(resolveValidationMessage({ code: "number.max", message: "x", parameters: { max: 100 } }, undefined, "en")).toBe("Enter a number of 100 or less");
  });
});
