import { afterEach, describe, expect, it } from "vitest";

import "../src/form.js";
import type { DatumFormChangeDetail, DatumFormElement } from "../src/form.js";
import type { FormDraft } from "@argusvane/datum-engine";

import { sampleDefinition, until } from "./helpers.js";
import { control, type } from "./live-dom.js";

afterEach(() => {
  document.body.innerHTML = "";
});

const COUNTRIES = [{ value: "CA", label: "Canada" }];
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function readyForm(): Promise<{ element: DatumFormElement; input: () => HTMLInputElement; changes: DatumFormChangeDetail[] }> {
  const element = document.createElement("datum-form") as DatumFormElement;
  element.dataSources = { countries: COUNTRIES };
  element.setAttribute("change-debounce", "60");
  element.definition = sampleDefinition();
  document.body.append(element);
  await until(() => element.renderer?.shadowRoot?.querySelector("form"));
  const changes: DatumFormChangeDetail[] = [];
  element.addEventListener("datum-change", (event) => changes.push((event as CustomEvent<DatumFormChangeDetail>).detail));
  const input = (): HTMLInputElement => control(element.renderer!.shadowRoot!, "fullName");
  return { element, input, changes };
}

describe("<datum-form> a typed change still pending", () => {
  it("reports what the form holds once a restored draft replaced the typed value", async () => {
    const { element, input, changes } = await readyForm();
    type(input(), "Dan");
    await element.runtime!.hydrateFromDraft({
      id: "d",
      formId: "sample-form",
      formVersion: "2.0.0",
      runtime: { schemaVersion: "1", rendererVersion: "t" },
      locale: "en",
      values: { fullName: "From draft" },
      state: { touched: [], dirty: [] },
      updatedAt: 1
    } as FormDraft);
    await settle(200);
    const reported = changes.filter((change) => change.path === "fullName");
    expect(reported.map((change) => change.value)).not.toContain("Dan");
    for (const change of reported) {
      expect(change.value).toBe(change.values.fullName);
    }
    expect(element.values.fullName).toBe("From draft");
  });

  it("is reported, not dropped, when a new catalog rebuilds the runtime under it", async () => {
    const { element, input, changes } = await readyForm();
    type(input(), "Ada");
    element.translations = { fr: { component: { fullName: { label: "Nom" } } } } as unknown as DatumFormElement["translations"];
    await settle(200);
    expect(element.values.fullName).toBe("Ada");
    expect(changes.filter((change) => change.path === "fullName").map((change) => change.value)).toEqual(["Ada"]);
  });
});
