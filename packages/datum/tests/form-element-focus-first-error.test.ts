import { afterEach, describe, expect, it } from "vitest";

import "../src/form.js";
import type { DatumFormElement, LiveBinding } from "../src/form.js";
import type { ComponentNode, FormDefinition } from "@argusvane/datum-engine";

import { createDatumBinding } from "../../../engine/form-engine/render/live/renderer.js";
import { until } from "./helpers.js";
import { control, summaryOf } from "./live-dom.js";

afterEach(() => {
  document.body.innerHTML = "";
});

/*
 * `accessibility.focusFirstError` on the definition decides where a failed check takes focus:
 * `false` keeps it on the summary, opening nothing, even for a binding that sends focus to the
 * first field in error. Left out or `true`, the binding decides.
 */

const TABS: ComponentNode[] = [
  {
    id: "period",
    type: "tabs",
    configuration: { tabs: [{ id: "day", label: "Past day" }, { id: "week", label: "Past week" }] },
    children: {
      day: [{ id: "dayNote", type: "text", configuration: { label: "Day note" } }],
      week: [{ id: "weekNote", type: "text", configuration: { label: "Week note", required: true } }]
    }
  }
];

async function mount(accessibility: FormDefinition["accessibility"], binding?: LiveBinding): Promise<{ element: DatumFormElement; root: ShadowRoot }> {
  const element = document.createElement("datum-form") as DatumFormElement;
  if (binding !== undefined) {
    element.binding = binding;
  }
  element.definition = {
    id: "focus-form",
    version: "1.0.0",
    schemaVersion: "1",
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }] },
    ...(accessibility !== undefined ? { accessibility } : {}),
    root: { id: "root", type: "form", configuration: {}, children: { content: TABS } }
  };
  document.body.append(element);
  await until(() => element.renderer?.shadowRoot?.querySelector("form"));
  return { element, root: element.renderer!.shadowRoot! };
}

const weekPanel = (root: ShadowRoot): HTMLElement => root.querySelector<HTMLElement>('[data-tab-panel="week"]')!;
const summaryAlert = (root: ShadowRoot): Element | null | undefined => summaryOf(root)?.querySelector("[role=alert]");
const fieldFirst = (): LiveBinding => ({ ...createDatumBinding(), errorFocus: "field" });

describe("<datum-form> accessibility.focusFirstError", () => {
  it("under a binding that sends focus to the field, takes it to the first field in error when left out", async () => {
    const { element, root } = await mount(undefined, fieldFirst());
    await until(() => weekPanel(root)?.hidden);
    await element.validate();
    await until(() => !weekPanel(root).hidden && root.activeElement === control(root, "weekNote"));
  });

  it("under the same binding, keeps focus on the summary and opens no tab when the definition says false", async () => {
    const { element, root } = await mount({ focusFirstError: false }, fieldFirst());
    await until(() => weekPanel(root)?.hidden);
    await element.validate();
    await until(() => summaryAlert(root) !== null && summaryAlert(root) !== undefined && root.activeElement === summaryAlert(root));
    expect(weekPanel(root).hidden).toBe(true);
  });

  it("leaves Datum's own look going to the summary, opening the tab first, unless the definition says false", async () => {
    const standard = await mount(undefined);
    await until(() => weekPanel(standard.root)?.hidden);
    await standard.element.validate();
    await until(() => onSummary(standard.root));
    expect(weekPanel(standard.root).hidden).toBe(false);
    document.body.innerHTML = "";

    const off = await mount({ focusFirstError: false });
    await until(() => weekPanel(off.root)?.hidden);
    await off.element.validate();
    await until(() => onSummary(off.root));
    expect(weekPanel(off.root).hidden).toBe(true);
  });
});

function onSummary(root: ShadowRoot): boolean {
  const alert = summaryAlert(root);
  return alert !== null && alert !== undefined && root.activeElement === alert;
}
