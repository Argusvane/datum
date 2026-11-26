import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import { formDefinitionProblem, toFormDefinition } from "../src/support.js";
import { until } from "./helpers.js";

/*
 * What Open refuses before a file replaces the form, said where the problem is: the shapes of the
 * languages, the PDF block, the journeys block and a component's slots. What a journey or a layout
 * points at is not checked, so a journey page naming a component the form lacks still opens.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const form = (extra: Record<string, unknown> = {}, children: unknown = { content: [{ id: "fullName", type: "text", configuration: { label: "Full name" } }] }): any => ({
  id: "f",
  version: "1.0.0",
  schemaVersion: "1",
  root: { id: "root", type: "form", configuration: {}, children },
  ...extra
});

const problem = (extra: Record<string, unknown>, children?: unknown): string | undefined => formDefinitionProblem(form(extra, children));

describe("Open's language block", () => {
  it("refuses a default language that is not a code", () => {
    expect(problem({ localization: { defaultLocale: 5 } })).toBe("localization.defaultLocale must be a locale code");
    expect(problem({ localization: { defaultLocale: { code: "en" } } })).toBe("localization.defaultLocale must be a locale code");
    expect(problem({ localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }] } })).toBeUndefined();
  });

  it("refuses supported languages that are not a list", () => {
    expect(problem({ localization: { supportedLocales: "en" } })).toBe("localization.supportedLocales must be a list of locales");
    expect(problem({ localization: { supportedLocales: { code: "en" } } })).toBe("localization.supportedLocales must be a list of locales");
  });

  it("refuses an entry that is not { code, label? }, naming its place", () => {
    expect(problem({ localization: { supportedLocales: [{ label: "English" }] } })).toBe("localization.supportedLocales[0] must be { code, label? }");
    expect(problem({ localization: { supportedLocales: [{ code: "en" }, "fr"] } })).toBe("localization.supportedLocales[1] must be { code, label? }");
    expect(problem({ localization: { supportedLocales: [{ code: "en" }, null] } })).toBe("localization.supportedLocales[1] must be { code, label? }");
    expect(problem({ localization: { supportedLocales: [{ code: 7 }] } })).toBe("localization.supportedLocales[0] must be { code, label? }");
    // A label is optional.
    expect(problem({ localization: { supportedLocales: [{ code: "en" }, { code: "fr", label: "Français" }] } })).toBeUndefined();
  });
});

describe("Open's PDF block", () => {
  it("refuses a default layout that is not a layout id", () => {
    expect(problem({ pdf: { layouts: [], defaultLayoutId: 5 } })).toBe("pdf.defaultLayoutId must be a layout id");
    expect(problem({ pdf: { defaultLayoutId: { id: "letter" } } })).toBe("pdf.defaultLayoutId must be a layout id");
    expect(problem({ pdf: { layouts: [], defaultLayoutId: "letter" } })).toBeUndefined();
  });
});

describe("Open's journeys block", () => {
  it("refuses a default journey that is not a journey id", () => {
    expect(problem({ journey: { journeys: [], defaultJourneyId: 5 } })).toBe("journey.defaultJourneyId must be a journey id");
    expect(problem({ journey: { defaultJourneyId: ["solo"] } })).toBe("journey.defaultJourneyId must be a journey id");
  });

  it("refuses an opensAs that is neither \"journey\" nor \"form\"", () => {
    expect(problem({ journey: { journeys: [], opensAs: "both" } })).toBe('journey.opensAs must be "journey" or "form"');
    expect(problem({ journey: { opensAs: true } })).toBe('journey.opensAs must be "journey" or "form"');
    expect(problem({ journey: { journeys: [], opensAs: "journey" } })).toBeUndefined();
    expect(problem({ journey: { journeys: [], opensAs: "form" } })).toBeUndefined();
  });

  it("opens a journey whose page names a component the form does not have", () => {
    const ghost = { journeys: [{ id: "solo", pages: [{ id: "one", components: ["fullName", "ghost"] }] }] };
    expect(problem({ journey: ghost })).toBeUndefined();
  });
});

describe("Open's component slots", () => {
  it("refuses a slot that is not a list of components, naming its place", () => {
    expect(problem({}, { content: { id: "a", type: "text" } })).toBe("root.children.content must be a list of component nodes");
    expect(problem({}, { content: "none" })).toBe("root.children.content must be a list of component nodes");
    // Down the tree, in a component's own slots.
    expect(problem({}, { content: [{ id: "box", type: "fieldset", configuration: {}, children: { content: 3 } }] })).toBe(
      "root.children.content[0].children.content must be a list of component nodes"
    );
    expect(problem({}, { content: [{ id: "a", type: "text" }, { id: "box", type: "fieldset", children: { rows: [], extra: null } }] })).toBe(
      "root.children.content[1].children.extra must be a list of component nodes"
    );
    expect(problem({}, { content: [], footer: [] })).toBeUndefined();
  });
});

describe("<datum-form-builder> Open", () => {
  async function builder(): Promise<DatumFormBuilderElement> {
    const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    document.body.append(element);
    await until(() => element.controller);
    return element;
  }

  it("takes a file whose journey page names an absent component, and refuses one with a malformed slot, leaving the form as it was", async () => {
    const element = await builder();
    const open = element.fileActions.open!;
    const ghost = { journeys: [{ id: "solo", pages: [{ id: "one", components: ["fullName", "ghost"] }] }] };

    const apply = (await open({ name: "journey.json", text: JSON.stringify(form({ journey: ghost })) })) as () => void;
    apply();
    await until(() => element.definition.journey !== undefined);
    expect(element.definition.journey).toEqual(ghost);
    expect(element.definition.root.children?.content?.map((child) => child.id)).toEqual(["fullName"]);

    await expect(Promise.resolve().then(() => open({ name: "slot.json", text: JSON.stringify(form({}, { content: "none" })) }))).rejects.toThrow(
      "root.children.content must be a list of component nodes"
    );
    await expect(Promise.resolve().then(() => open({ name: "opens.json", text: JSON.stringify(form({ journey: { opensAs: "both" } })) }))).rejects.toThrow(
      'journey.opensAs must be "journey" or "form"'
    );
    // Neither refusal touched the form.
    expect(element.definition.journey).toEqual(ghost);
    expect(toFormDefinition(JSON.parse(JSON.stringify(element.definition))).id).toBe("f");
  });
});
