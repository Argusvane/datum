import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The inspector's "Reads as" line asks for the Logic model's chunk. When the
 * chunk is gone the rule stays worded as its printed formula, the host hears once, and the chunk
 * is NOT asked for again by every keystroke in a rule: only when another selection is opened
 * (or after a 30 s back-off).
 */
const gone = vi.hoisted(() => ({ fail: 99, asked: 0 }));
vi.mock("../../../engine/form-engine/builder/logic/logic-model.ts", async (importOriginal) => {
  gone.asked += 1;
  if (gone.fail > 0) {
    gone.fail -= 1;
    throw new Error("logic model chunk gone");
  }
  return importOriginal();
});

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const inspector = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector("datum-builder-properties")!.shadowRoot!;

describe("a missing Logic model chunk under the Reads as line", () => {
  it("is asked for once, reported once, left alone while the author types, and asked again for another selection", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const element = document.createElement("datum-form-builder");
    element.definition = sampleDefinition();
    const errors: Array<{ message: string; cause: unknown }> = [];
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string; cause: unknown }>).detail));
    document.body.append(element);
    await until(() => shell(element).querySelector("datum-builder-properties"));
    element.builder!.controller.select("fullName");
    await until(() => inspector(element).querySelector("[data-inspector-title]"));
    inspector(element).querySelector<HTMLButtonElement>('[data-inspector-tab="rules"]')!.click();
    await until(() => inspector(element).querySelector('[data-rule="defaultValue"][data-rule-mode="formula"]'));
    inspector(element).querySelector<HTMLButtonElement>('[data-rule="defaultValue"][data-rule-mode="formula"]')!.click();
    const formulaBox = (): HTMLTextAreaElement => inspector(element).querySelector<HTMLTextAreaElement>('[data-rule="defaultValue"][data-rule-formula]')!;
    await until(() => inspector(element).querySelector('[data-rule="defaultValue"][data-rule-formula]'));
    const box = formulaBox();
    for (const formula of ["1", "12", "123", "1234"]) {
      box.value = formula;
      box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    // The line is the printed formula, the chunk was asked for once, the host heard once.
    await until(() => inspector(element).querySelector('[data-rule-feedback="defaultValue"] [data-rule-reads]'));
    expect(gone.asked).toBe(1);
    expect(errors.filter((entry) => entry.message.includes("plain-words"))).toHaveLength(1);
    // Another selection is a fresh start: it asks again.
    element.builder!.controller.select("email");
    await until(() => inspector(element).querySelector("[data-inspector-title]")?.textContent?.length);
    inspector(element).querySelector<HTMLButtonElement>('[data-inspector-tab="rules"]')!.click();
    await until(() => inspector(element).querySelector('[data-rule="defaultValue"][data-rule-mode="formula"]'));
    inspector(element).querySelector<HTMLButtonElement>('[data-rule="defaultValue"][data-rule-mode="formula"]')!.click();
    await until(() => inspector(element).querySelector('[data-rule="defaultValue"][data-rule-formula]'));
    const second = formulaBox();
    second.value = "5";
    second.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await until(() => gone.asked >= 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Still one report for the burst: the host is not told again until a load succeeds.
    expect(errors.filter((entry) => entry.message.includes("plain-words"))).toHaveLength(1);
  }, 20000);
});
