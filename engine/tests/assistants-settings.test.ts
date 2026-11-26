// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  ASSISTANTS_CHOICES,
  assistantsChoiceOf,
  assistantsDraftValue,
  assistantsHint,
  assistantsSettingsSectionHtml
} from "../form-engine/builder/web-component/assistants-settings.js";
import { BUILDER_TEXTS_EN, builderText } from "../form-engine/builder/logic/builder-texts.js";

// The Form panel's Browser assistants row: the markup and the three
// small functions around root.configuration.agentTools. The panel wiring is in the packages/datum suite.
const section = (html: string): Document => new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");

describe("assistantsChoiceOf", () => {
  it.each([
    ["allowed", "allowed"],
    ["off", "off"],
    [undefined, "unset"],
    ["maybe", "unset"],
    [true, "unset"],
    ["Off", "unset"],
    ["", "unset"]
  ])("reads %j as %s", (value, expected) => {
    expect(assistantsChoiceOf(value)).toBe(expected);
  });
});

describe("assistantsDraftValue", () => {
  it("drafts the empty string for Not set, so the controller removes the key, and the word otherwise", () => {
    expect(assistantsDraftValue("unset")).toBe("");
    expect(assistantsDraftValue("allowed")).toBe("allowed");
    expect(assistantsDraftValue("off")).toBe("off");
    expect(ASSISTANTS_CHOICES).toEqual(["unset", "allowed", "off"]);
  });
});

describe("assistantsHint", () => {
  it("is the catalog's line for the choice", () => {
    expect(assistantsHint("unset")).toBe(builderText("settings.agentTools.unset.hint"));
    expect(assistantsHint("allowed")).toBe("Assistants may fill this form where the site offers them.");
    expect(assistantsHint("off")).toContain("For forms the person must complete themselves");
    expect(new Set(ASSISTANTS_CHOICES.map((choice) => assistantsHint(choice))).size).toBe(3);
  });

  it("reads a host's catalog over the English, key by key", () => {
    const texts = { locale: "fr", catalog: { fr: { "settings.agentTools.off.hint": "Pour une déclaration." } } };
    expect(assistantsHint("off", texts)).toBe("Pour une déclaration.");
    expect(assistantsHint("allowed", texts)).toBe(BUILDER_TEXTS_EN["settings.agentTools.allowed.hint"]);
  });
});

describe("assistantsSettingsSectionHtml", () => {
  it("draws three options in order, the right one selected, and both hint lines the select describes", () => {
    for (const value of ASSISTANTS_CHOICES) {
      const root = section(assistantsSettingsSectionHtml({ value, managed: false }, false));
      const details = root.querySelector<HTMLElement>('details.inspector-section[data-inspector-section="assistants"]')!;
      expect(details.hasAttribute("open")).toBe(false);
      expect(details.querySelector("summary")!.textContent).toBe("Browser assistants");
      const select = root.querySelector<HTMLSelectElement>("select[data-agent-tools]")!;
      expect([...select.options].map((option) => option.value)).toEqual(["", "allowed", "off"]);
      expect([...select.options].map((option) => option.textContent)).toEqual(["Not set", "Allowed", "Not on this form"]);
      expect([...select.options].filter((option) => option.hasAttribute("selected")).map((option) => option.value)).toEqual([value === "unset" ? "" : value]);
      expect(select.getAttribute("aria-describedby")).toBe("agent-tools-hint agent-tools-note");
      expect(root.querySelector("#agent-tools-hint")!.hasAttribute("data-agent-tools-hint")).toBe(true);
      expect(root.querySelector("#agent-tools-hint")!.textContent).toBe(assistantsHint(value));
      expect(root.querySelector("#agent-tools-note")!.textContent).toBe(builderText("settings.agentTools.hint"));
      expect(root.querySelector("label.property-row strong")!.textContent).toBe("Assistants in the browser");
      expect(root.querySelector("[data-managed-setting]")).toBeNull();
    }
  });

  it("opens when asked", () => {
    const root = section(assistantsSettingsSectionHtml({ value: "unset", managed: false }, true));
    expect(root.querySelector("details")!.hasAttribute("open")).toBe(true);
  });

  it("draws the managed row, with no select, no value and no hint, when the site manages the setting", () => {
    const root = section(assistantsSettingsSectionHtml({ value: "allowed", managed: true }, true));
    const row = root.querySelector('[data-managed-setting="agentTools"]')!;
    expect(row.querySelector(".field-label")!.textContent).toBe("Assistants in the browser");
    expect(row.querySelector(".field-note")!.textContent).toBe("Managed by the site.");
    expect(root.querySelector("summary")!.textContent).toBe("Browser assistants");
    expect(root.querySelector("select")).toBeNull();
    expect(root.querySelector("option")).toBeNull();
    expect(root.querySelector("[data-agent-tools-hint]")).toBeNull();
    expect(root.querySelector("#agent-tools-note")).toBeNull();
    expect(root.body.innerHTML).not.toContain("selected");
    expect(root.body.textContent).not.toContain("Allowed");
    expect(row.querySelector(".field-note")!.getAttribute("data-severity")).toBe("info");
  });

  it("escapes a host's catalog text", () => {
    const texts = { locale: "fr", catalog: { fr: { "settings.agentTools.title": 'A "<b>" & C' } } };
    const html = assistantsSettingsSectionHtml({ value: "unset", managed: false, texts }, false);
    expect(html).toContain("A &quot;&lt;b&gt;&quot; &amp; C");
    expect(html).not.toContain("<b>");
  });
});
