import { describe, expect, it } from "vitest";

import {
  clearComponentPrintEdits,
  componentPrintEntries,
  defaultRenditionEdits,
  insertAt,
  insertionText,
  journeyPageBreaksEdits,
  printFieldOptions,
  printSettingsView,
  renditionToggleEdits,
  scaleEdits,
  settledPrintEdits,
  slotEdits,
  slotResetEdits,
  titleOnFirstPageEdits,
  type PrintEdit
} from "../form-engine/builder/print/print-settings-model.js";
import { sourceHash, type FormTranslations } from "../form-engine/core/localization/translations.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/** The Print workspace's settings card as a pure model over the form root's `configuration.print`. */

const WORDS = { pageNumber: "Page {{page}} of {{pages}}" };

/** The edits applied to a configuration, as the controller's setProperties would write them. */
function apply(configuration: Record<string, unknown>, edits: readonly PrintEdit[]): Record<string, unknown> {
  const next = structuredClone(configuration);
  for (const edit of edits) {
    const parts = edit.propertyPath.split(".");
    let at = next;
    for (const part of parts.slice(0, -1)) {
      at[part] = (at[part] as Record<string, unknown> | undefined) ?? {};
      at = at[part] as Record<string, unknown>;
    }
    const last = parts.at(-1)!;
    if (edit.value === undefined) {
      delete at[last];
    } else {
      at[last] = edit.value;
    }
  }
  return next;
}

describe("printSettingsView", () => {
  it("reads the defaults for a form that says nothing, each slot showing what prints there", () => {
    const view = printSettingsView({ title: "Intake" }, WORDS);
    expect(view.offered).toEqual(["answers"]);
    expect(view.defaultRendition).toBe("answers");
    expect(view.titleOnFirstPage).toBe(true);
    expect(view.scalePercent).toBe(100);
    expect(view.journeyPageBreaks).toBe(false);
    expect(view.slots.map((slot) => [slot.propertyPath, slot.value, slot.authored])).toEqual([
      ["print.header.start", "{{title}}", false],
      ["print.header.end", "", false],
      ["print.footer.start", "{{title}}", false],
      ["print.footer.end", "Page {{page}} of {{pages}}", false]
    ]);
  });

  it("reads what the form says, an empty slot as authored nothing", () => {
    const view = printSettingsView(
      { print: { renditions: ["filled", "answers", "bogus"], defaultRendition: "filled", titleOnFirstPage: false, scale: 0.8, header: { end: "" }, footer: { end: "{{date}}" }, journeyPageBreaks: true } },
      WORDS
    );
    // Offered in the renditions' own order.
    expect(view.offered).toEqual(["answers", "filled"]);
    expect(view.defaultRendition).toBe("filled");
    expect(view.titleOnFirstPage).toBe(false);
    expect(view.scalePercent).toBe(80);
    expect(view.journeyPageBreaks).toBe(true);
    expect(view.slots[1]).toMatchObject({ value: "", authored: true });
    expect(view.slots[3]).toMatchObject({ value: "{{date}}", authored: true, defaultText: "Page {{page}} of {{pages}}" });
  });

  it("never throws on odd input", () => {
    for (const odd of [undefined, null, 4, "x", [], { print: 7 }, { print: { header: "yes", renditions: "all" } }]) {
      expect(() => printSettingsView(odd, WORDS)).not.toThrow();
      expect(printSettingsView(odd, WORDS).offered).toEqual(["answers"]);
    }
  });
});

describe("the versions", () => {
  it("writes the offered list in order, clearing it when it is the default again", () => {
    const offered = renditionToggleEdits({}, "blank", true)!;
    expect(offered).toEqual([{ propertyPath: "print.renditions", value: ["answers", "blank"] }]);
    const config = apply({}, offered);
    expect(renditionToggleEdits(config, "blank", false)).toEqual([{ propertyPath: "print.renditions", value: undefined }]);
  });

  it("keeps at least one offered: unticking the last is refused", () => {
    expect(renditionToggleEdits({}, "answers", false)).toBeUndefined();
    const onlyBlank = { print: { renditions: ["blank"] } };
    expect(renditionToggleEdits(onlyBlank, "blank", false)).toBeUndefined();
    // Ticking what is already ticked changes nothing.
    expect(renditionToggleEdits({}, "answers", true)).toEqual([]);
  });

  it("moves the default along when its own version is unticked", () => {
    const config = { print: { renditions: ["answers", "blank", "filled"], defaultRendition: "blank" } };
    const edits = renditionToggleEdits(config, "blank", false)!;
    const next = apply(config, edits);
    expect(printSettingsView(next, WORDS).offered).toEqual(["answers", "filled"]);
    expect(printSettingsView(next, WORDS).defaultRendition).toBe("answers");
    expect((next.print as Record<string, unknown>).defaultRendition).toBeUndefined();
  });

  it("keeps a default the form never wrote where it is when a version before it is ticked", () => {
    const config = { print: { renditions: ["filled"] } };
    const next = apply(config, renditionToggleEdits(config, "answers", true)!);
    expect(printSettingsView(next, WORDS).defaultRendition).toBe("filled");
  });

  it("sets the default among the offered ones only, clearing it when it is the first", () => {
    const config = { print: { renditions: ["answers", "blank"] } };
    expect(defaultRenditionEdits(config, "blank")).toEqual([{ propertyPath: "print.defaultRendition", value: "blank" }]);
    expect(defaultRenditionEdits(config, "answers")).toEqual([{ propertyPath: "print.defaultRendition", value: undefined }]);
    expect(defaultRenditionEdits(config, "filled")).toEqual([]);
  });

  it("reads the unwritten default from the order stored, not the canonical one", () => {
    const config = { print: { renditions: ["blank", "answers"] } };
    expect(printSettingsView(config, WORDS).defaultRendition).toBe("blank");
    // Answers is not what an unwritten default reads as here, so choosing it is written.
    const picked = apply(config, defaultRenditionEdits(config, "answers"));
    expect(printSettingsView(picked, WORDS).defaultRendition).toBe("answers");
    // Blank is, so choosing it writes nothing.
    expect(defaultRenditionEdits(config, "blank")).toEqual([{ propertyPath: "print.defaultRendition", value: undefined }]);
  });
});

describe("settledPrintEdits", () => {
  /** What the controller's write does to a key: creates every parent and assigns, an undefined leaf included. */
  function assign(configuration: Record<string, unknown>, edits: readonly PrintEdit[]): Record<string, unknown> {
    const next = structuredClone(configuration);
    for (const edit of edits) {
      const parts = edit.propertyPath.split(".");
      let at = next;
      for (const part of parts.slice(0, -1)) {
        at[part] = (at[part] as Record<string, unknown> | undefined) ?? {};
        at = at[part] as Record<string, unknown>;
      }
      at[parts.at(-1)!] = edit.value;
    }
    return next;
  }

  it("writes nothing for a reset of a setting the form never wrote", () => {
    expect(settledPrintEdits({ title: "Intake" }, slotResetEdits("header", "start"))).toEqual([]);
    expect(settledPrintEdits({ title: "Intake", print: {} }, titleOnFirstPageEdits(true))).toEqual([]);
  });

  it("leaves no empty header, footer or print block behind a cleared setting", () => {
    const config = { title: "Intake", print: { header: { start: "A" }, titleOnFirstPage: false } };
    const header = assign(config, settledPrintEdits(config, slotResetEdits("header", "start")));
    expect(JSON.stringify(header)).toBe('{"title":"Intake","print":{"titleOnFirstPage":false}}');
    const last = { title: "Intake", print: { header: { start: "A" } } };
    const gone = settledPrintEdits(last, slotResetEdits("header", "start"));
    expect(gone).toEqual([{ propertyPath: "print", value: undefined }]);
    expect(JSON.stringify(assign(last, gone))).toBe('{"title":"Intake"}');
  });

  it("keeps the other slot of a header and writes only the keys that change", () => {
    const config = { print: { header: { start: "A", end: "B" } } };
    expect(settledPrintEdits(config, slotResetEdits("header", "start"))).toEqual([{ propertyPath: "print.header", value: { end: "B" } }]);
    expect(settledPrintEdits(config, slotEdits("header", "start", "A"))).toEqual([]);
    expect(settledPrintEdits({}, [...titleOnFirstPageEdits(false), ...journeyPageBreaksEdits(true)])).toEqual([
      { propertyPath: "print.titleOnFirstPage", value: false },
      { propertyPath: "print.journeyPageBreaks", value: true }
    ]);
  });
});

describe("the page, the slots and the journey breaks", () => {
  it("writes the title, the journey breaks and the scale, clearing each at its default", () => {
    expect(titleOnFirstPageEdits(false)).toEqual([{ propertyPath: "print.titleOnFirstPage", value: false }]);
    expect(titleOnFirstPageEdits(true)).toEqual([{ propertyPath: "print.titleOnFirstPage", value: undefined }]);
    expect(journeyPageBreaksEdits(true)).toEqual([{ propertyPath: "print.journeyPageBreaks", value: true }]);
    expect(journeyPageBreaksEdits(false)).toEqual([{ propertyPath: "print.journeyPageBreaks", value: undefined }]);
    expect(scaleEdits("80")).toEqual([{ propertyPath: "print.scale", value: 0.8 }]);
    expect(scaleEdits(" 125 % ")).toEqual([{ propertyPath: "print.scale", value: 1.25 }]);
    expect(scaleEdits("100")).toEqual([{ propertyPath: "print.scale", value: undefined }]);
    // A half-typed or out-of-range number writes nothing.
    for (const text of ["", "8.", "abc", "10", "250", "-50"]) {
      expect(scaleEdits(text), text).toBeUndefined();
    }
  });

  it("writes a slot as typed, empty included, and a reset clears it back to the default", () => {
    expect(slotEdits("header", "end", "Ref {{receipt.reference}}")).toEqual([{ propertyPath: "print.header.end", value: "Ref {{receipt.reference}}" }]);
    expect(slotEdits("footer", "start", "")).toEqual([{ propertyPath: "print.footer.start", value: "" }]);
    const config = apply({ print: { footer: { end: "{{date}}" } } }, slotResetEdits("footer", "end"));
    const view = printSettingsView(config, WORDS);
    expect(view.slots[3]).toMatchObject({ value: "Page {{page}} of {{pages}}", authored: false });
  });

  it("words the insert shortcuts and puts them at the caret, spaced from the words around", () => {
    expect(insertionText("title", WORDS)).toBe("{{title}}");
    expect(insertionText("pages", WORDS)).toBe("Page {{page}} of {{pages}}");
    expect(insertionText("date", WORDS)).toBe("{{date}}");
    expect(insertionText("receipt", WORDS)).toBe("{{receipt.reference}}");
    expect(insertionText("field", WORDS, "address.zip")).toBe("{{address.zip}}");
    expect(insertionText("field", WORDS)).toBe("");
    expect(insertAt("Ref", 3, 3, "{{date}}")).toEqual({ text: "Ref {{date}}", caret: 12 });
    expect(insertAt("Ref end", 3, 3, "{{date}}")).toEqual({ text: "Ref {{date}} end", caret: 12 });
    expect(insertAt("", 0, 0, "{{title}}")).toEqual({ text: "{{title}}", caret: 9 });
    expect(insertAt("Hello world", 6, 11, "{{title}}")).toEqual({ text: "Hello {{title}}", caret: 15 });
  });
});

describe("the components that say how they print", () => {
  const root: ComponentNode = {
    id: "root",
    type: "form",
    configuration: { title: "T" },
    children: {
      content: [
        { id: "name", type: "text", configuration: { label: "Name" } },
        {
          id: "household",
          type: "panel",
          configuration: { label: "Household", print: { breakBefore: true, keepTogether: true } },
          children: { content: [{ id: "office", type: "html", configuration: { content: "<p>x</p>", print: { on: "paper" } } }] }
        },
        { id: "address", type: "container", configuration: { label: "Address", scopeData: true }, children: { content: [{ id: "zip", type: "text", configuration: { label: "Postcode", dataKey: "postcode" } }] } },
        { id: "items", type: "panel", collection: { collectionPath: "items", itemFields: ["qty"] }, configuration: { label: "Items" }, children: { content: [{ id: "qty", type: "number", configuration: { label: "Qty" } }] } }
      ]
    }
  };

  it("lists them in the form's order, with their settings and their name in the language asked", () => {
    const translations = { fr: { components: { household: { label: { text: "Ménage", source: sourceHash("Household") } } } } } as unknown as FormTranslations;
    const entries = componentPrintEntries(root, "fr", { translations });
    expect(entries.map((entry) => [entry.id, entry.label])).toEqual([
      ["household", "Ménage"],
      ["office", "office"]
    ]);
    expect(entries[0]!.settings).toMatchObject({ breakBefore: true, keepTogether: true, on: "both" });
    expect(entries[1]!.settings.on).toBe("paper");
  });

  it("clears a component's place, breaks and rule behaviour in one batch, its note left alone", () => {
    expect(clearComponentPrintEdits("household").map((edit) => [edit.componentId, edit.propertyPath, edit.value])).toEqual([
      ["household", "print.on", undefined],
      ["household", "print.breakBefore", undefined],
      ["household", "print.keepTogether", undefined],
      ["household", "print.show", undefined]
    ]);
  });

  it("offers the fields that hold an answer by value path, outside repeating sections", () => {
    expect(printFieldOptions(root, "en")).toEqual([
      { path: "name", label: "Name" },
      { path: "address.postcode", label: "Postcode" }
    ]);
    expect(printFieldOptions(undefined as never, "en")).toEqual([]);
  });
});
