import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRINT_CONFIGURATION,
  PRINT_SCALE_MAX,
  PRINT_SCALE_MIN,
  readPrintConfiguration
} from "../form-engine/core/schema/print.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { livePrintPlan, paperOnlyApplies, readComponentPrintSettings, readComponentPrintShow } from "../form-engine/render/core/print-options.js";

describe("readPrintConfiguration", () => {
  it("prints the answers with the title in the header and footer and the page number line when the form says nothing", () => {
    const expected = {
      renditions: ["answers"],
      defaultRendition: "answers",
      titleOnFirstPage: true,
      scale: 1,
      journeyPageBreaks: false,
      header: { start: "{{title}}", end: "" },
      footer: { start: "{{title}}", end: undefined }
    };
    expect(DEFAULT_PRINT_CONFIGURATION).toEqual(expected);
    for (const configuration of [undefined, { title: "Intake" }, { print: null }, { print: [] }, "junk", { print: {} }]) {
      expect(readPrintConfiguration(configuration)).toEqual(expected);
    }
  });

  it("returns a fresh object each time, never the shared default", () => {
    const a = readPrintConfiguration(undefined);
    a.scale = 0.5;
    a.header.start = "changed";
    a.renditions.push("blank");
    const b = readPrintConfiguration({ print: {} });
    expect(b.scale).toBe(1);
    expect(b.header.start).toBe("{{title}}");
    expect(b.renditions).toEqual(["answers"]);
    expect(DEFAULT_PRINT_CONFIGURATION.scale).toBe(1);
    expect(Object.isFrozen(DEFAULT_PRINT_CONFIGURATION.header)).toBe(true);
  });

  it("honours each switch the form sets, and only real booleans", () => {
    expect(readPrintConfiguration({ print: { titleOnFirstPage: false, journeyPageBreaks: true } })).toMatchObject({ titleOnFirstPage: false, journeyPageBreaks: true });
    // "no" is not false; a string, a number or null takes the default.
    expect(readPrintConfiguration({ print: { titleOnFirstPage: "no", journeyPageBreaks: 1 } })).toMatchObject({ titleOnFirstPage: true, journeyPageBreaks: false });
  });

  it("reads each slot: absent is the default, an empty string is nothing, anything but a string is the default", () => {
    expect(readPrintConfiguration({ print: { header: { start: "", end: "Ref {{receipt.reference}}" }, footer: { start: "{{date}}", end: "{{page}}" } } })).toMatchObject({
      header: { start: "", end: "Ref {{receipt.reference}}" },
      footer: { start: "{{date}}", end: "{{page}}" }
    });
    expect(readPrintConfiguration({ print: { header: { start: 5, end: null }, footer: { start: ["x"], end: false } } })).toMatchObject({
      header: { start: "{{title}}", end: "" },
      footer: { start: "{{title}}", end: undefined }
    });
    // A slot left out keeps its default beside one written.
    expect(readPrintConfiguration({ print: { footer: { end: "" } } }).footer).toEqual({ start: "{{title}}", end: "" });
    expect(readPrintConfiguration({ print: { footer: { start: "" } } }).footer).toEqual({ start: "", end: undefined });
  });

  it("reads the old switches as no band at all: the defaults, no shim", () => {
    const old = readPrintConfiguration({ print: { header: false, footer: true, pageNumbers: false } });
    expect(old.header).toEqual({ start: "{{title}}", end: "" });
    expect(old.footer).toEqual({ start: "{{title}}", end: undefined });
    expect(old).not.toHaveProperty("pageNumbers");
  });

  it("keeps the known renditions once each in the order written, and a default among them", () => {
    expect(readPrintConfiguration({ print: { renditions: ["blank", "answers", "blank", "poster", 3] } })).toMatchObject({ renditions: ["blank", "answers"], defaultRendition: "blank" });
    expect(readPrintConfiguration({ print: { renditions: ["answers", "filled"], defaultRendition: "filled" } })).toMatchObject({ renditions: ["answers", "filled"], defaultRendition: "filled" });
    // A default the form does not offer is the first it does.
    expect(readPrintConfiguration({ print: { renditions: ["filled", "blank"], defaultRendition: "answers" } }).defaultRendition).toBe("filled");
    expect(readPrintConfiguration({ print: { defaultRendition: "blank" } })).toMatchObject({ renditions: ["answers"], defaultRendition: "answers" });
    // None usable is the answers alone.
    for (const renditions of [[], ["poster"], "blank", null]) {
      expect(readPrintConfiguration({ print: { renditions } })).toMatchObject({ renditions: ["answers"], defaultRendition: "answers" });
    }
  });

  it("keeps the scale within the printable range, and defaults anything unusable", () => {
    expect(readPrintConfiguration({ print: { scale: 0.8 } }).scale).toBe(0.8);
    expect(readPrintConfiguration({ print: { scale: 0.01 } }).scale).toBe(PRINT_SCALE_MIN);
    expect(readPrintConfiguration({ print: { scale: 9 } }).scale).toBe(PRINT_SCALE_MAX);
    // A cleared number box yields 0 and a non-numeric one NaN; neither is a scale.
    expect(readPrintConfiguration({ print: { scale: 0 } }).scale).toBe(1);
    expect(readPrintConfiguration({ print: { scale: Number.NaN } }).scale).toBe(1);
    expect(readPrintConfiguration({ print: { scale: -1 } }).scale).toBe(1);
    expect(readPrintConfiguration({ print: { scale: "0.8" } }).scale).toBe(1);
  });
});

describe("readComponentPrintSettings", () => {
  it("defaults every choice, and reads only what it knows", () => {
    const defaults = { on: "both", show: "auto", breakBefore: false, keepTogether: false };
    for (const configuration of [undefined, null, {}, { print: null }, { print: [] }, { print: "x" }, { print: {} }]) {
      expect(readComponentPrintSettings(configuration)).toEqual(defaults);
    }
    expect(readComponentPrintSettings({ print: { on: "screen", show: "always", breakBefore: true, keepTogether: true } })).toEqual({
      on: "screen",
      show: "always",
      breakBefore: true,
      keepTogether: true
    });
    expect(readComponentPrintSettings({ print: { on: "paper", show: "answered" } })).toMatchObject({ on: "paper", show: "answered" });
    // "never" is no show any more, and a truthy non-boolean is no break.
    expect(readComponentPrintSettings({ print: { on: "nowhere", show: "never", breakBefore: "yes", keepTogether: 1 } })).toEqual(defaults);
    expect(readComponentPrintShow({ print: { show: "never" } })).toBe("auto");
  });
});

describe("livePrintPlan and on: screen", () => {
  it("drops a screen-only component with all it holds, an always one inside it too", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "name", type: "text", configuration: {} },
          {
            id: "office",
            type: "fieldset",
            configuration: { print: { on: "screen" } },
            children: { content: [{ id: "officer", type: "text", configuration: { print: { show: "always" } } }] }
          },
          { id: "stamp", type: "html", configuration: { print: { on: "paper" } } }
        ]
      }
    };
    const plan = livePrintPlan(root);
    expect(plan.decide("office", false)).toBe("drop");
    expect(plan.decide("officer", false)).toBe("drop");
    expect(plan.holdsKept("office")).toBe(false);
    expect(plan.decide("name", false)).toBeUndefined();
    // Paper-only prints as anything else does.
    expect(plan.decide("stamp", false)).toBeUndefined();
  });
});

describe("paperOnlyApplies", () => {
  it("holds for what carries no answer and holds none, never for a question", () => {
    expect(paperOnlyApplies({ type: "html" })).toBe(true);
    expect(paperOnlyApplies({ type: "image" })).toBe(true);
    expect(paperOnlyApplies({ type: "panel", children: { content: [{ id: "a", type: "html", configuration: {} }, { id: "b", type: "image", configuration: {} }] } })).toBe(true);
    expect(paperOnlyApplies({ type: "panel", children: { content: [] } })).toBe(true);
    expect(paperOnlyApplies({ type: "text" })).toBe(false);
    expect(paperOnlyApplies({ type: "fieldset", children: { content: [{ id: "a", type: "html", configuration: {} }, { id: "b", type: "checkbox", configuration: {} }] } })).toBe(false);
    expect(paperOnlyApplies({ type: "dataGrid", children: { content: [{ id: "a", type: "html", configuration: {} }] } })).toBe(false);
    expect(paperOnlyApplies({ type: "container", collection: { collectionPath: "rows" }, children: { content: [{ id: "a", type: "html", configuration: {} }] } } as never)).toBe(false);
    // An unknown type may carry an answer; a mapped one is read as the base it is drawn as.
    expect(paperOnlyApplies({ type: "acme-widget" })).toBe(false);
    expect(paperOnlyApplies({ type: "gcds-input" }, { "gcds-input": "text" })).toBe(false);
    expect(paperOnlyApplies({ type: "gcds-panel", children: { content: [{ id: "a", type: "html", configuration: {} }] } }, { "gcds-panel": "panel" })).toBe(true);
    expect(paperOnlyApplies({ type: "gcds-panel", children: { content: [{ id: "a", type: "gcds-input", configuration: {} }] } }, { "gcds-panel": "panel", "gcds-input": "text" })).toBe(false);
  });
});
