import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import axe from "axe-core";
import type { FormDefinition, LiveBinding } from "@argusvane/datum-engine";

import type { DatumFormElement } from "../src/form-element.js";
import { AUDIT_STATES, axeRunOptions, normaliseAxeResults, type AuditResult } from "./audit-support.mjs";

/**
 * The jsdom half of the markup audit: axe-core's WCAG 2.2 A/AA rules over the fixture
 * form (a11y/form.json) as a binding draws it, in every audit state (tests/a11y-markup.test.ts).
 * The caller defines `<datum-form>` (imports the form entry) and installs the canvas stub around
 * the run.
 */

/** Polls `check` until it returns truthy, failing after `timeoutMs`. */
async function until(check: () => unknown, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("markup audit: condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Paths, not URLs: under jsdom `new URL()` is the page's class, which Node's fs refuses.
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(HERE, "form.json");

/** The committed baseline's shape (a11y/baseline/markup.json). */
export interface MarkupBaseline {
  axeVersion: string;
  states: string[];
  results: Record<string, Record<string, AuditResult>>;
}

export function markupFixture(): FormDefinition {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as FormDefinition;
}

/**
 * A canvas for axe-core's icon-ligature probe. From 4.14 `label-content-name-mismatch` asks
 * whether a widget's visible text is an icon ligature (it measures glyphs on a canvas), and
 * jsdom has no canvas: `getContext` answers null and the probe throws, which axe files as
 * "Axe encountered an error" instead of the finding a browser gets. This context answers the
 * probe as a plain text face would: every glyph 10px wide, the first glyph drawing the same
 * pixels as the whole text, so nothing is taken for a ligature. Only that probe reads it.
 * Answers the function that puts the original back.
 */
export function installCanvasStub(): () => void {
  const original = HTMLCanvasElement.prototype.getContext;
  const context = {
    font: "",
    textAlign: "",
    textBaseline: "",
    canvas: { width: 0, height: 0 },
    measureText: (text: string) => ({ width: 10 * text.length }),
    fillText: () => undefined,
    clearRect: () => undefined,
    getImageData: (_x: number, _y: number, width: number, height: number) => ({
      data: new Uint8ClampedArray(Math.max(1, Math.floor(width) * Math.floor(height)) * 4).fill(255)
    })
  };
  HTMLCanvasElement.prototype.getContext = (() => context) as unknown as typeof original;
  return () => {
    HTMLCanvasElement.prototype.getContext = original;
  };
}

/**
 * The audit of one binding's markup in every state (AUDIT_STATES), as the baseline stores it.
 * No binding means Datum's own, which the element draws by default.
 */
export async function auditBinding(binding?: LiveBinding): Promise<Record<string, AuditResult>> {
  const results: Record<string, AuditResult> = {};
  for (const state of AUDIT_STATES) {
    const element = document.createElement("datum-form") as DatumFormElement;
    if (binding) element.binding = binding;
    element.setAttribute("language-switcher", "");
    element.setAttribute("locale", state.locale);
    element.setAttribute("mode", state.mode);
    element.definition = markupFixture();
    document.body.append(element);
    try {
      await until(() => element.renderer?.shadowRoot?.querySelector("form"), 15000);
      const root = element.renderer!.shadowRoot!;
      if (state.invalid) {
        await element.validate();
        await until(() => root.querySelector("[data-summary], [role='alert']"));
      }
      // One frame for the renderer's post-paint work (focus, the count's live text).
      await new Promise((resolve) => setTimeout(resolve, 20));
      const raw = await axe.run(element, axeRunOptions({ colour: false }) as axe.RunOptions);
      results[state.id] = normaliseAxeResults(raw, (node) => (node as { element?: Element }).element);
    } finally {
      element.remove();
    }
  }
  return results;
}
