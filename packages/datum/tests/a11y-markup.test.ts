import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FormDefinition } from "@argusvane/datum-engine";

import "../src/form.js";
import type { DatumFormElement } from "../src/form-element.js";
import { AUDIT_STATES, axeRunOptions } from "../a11y/audit-support.mjs";
// The audit of the binding the element draws with, in every state, and the canvas stub it needs.
import { auditBinding, installCanvasStub, type MarkupBaseline } from "../a11y/markup-audit.js";
import { until } from "./helpers.js";

/**
 * The markup audit: axe-core's WCAG 2.2 A/AA rules over the fixture form as the
 * element draws it with Datum's binding, in jsdom. jsdom applies the shadow-root stylesheets
 * but lays nothing out, so this sees structure — labels, names, roles, states, relationships,
 * language — and not colour; the browser audit (`npm run a11y:browser`) sees both.
 *
 * Nothing here asserts "no violations". The audit's results are a committed baseline
 * (`a11y/baseline/markup.json`); the test fails when the markup drifts from it in either
 * direction, and `A11Y_UPDATE=1` rewrites the baseline after a look. The tracking document
 * is generated from the baseline (`npm run a11y:report`).
 */

// Paths, not URLs: under jsdom `new URL()` is the page's class, which Node's fs refuses.
const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_URL = resolve(HERE, "../a11y/baseline/markup.json");

function readBaseline(): MarkupBaseline | undefined {
  try {
    return JSON.parse(readFileSync(BASELINE_URL, "utf8")) as MarkupBaseline;
  } catch {
    return undefined;
  }
}

describe("the markup accessibility audit (axe-core in jsdom)", () => {
  let restoreCanvas = () => {};
  beforeEach(() => {
    restoreCanvas = installCanvasStub();
  });
  afterEach(() => {
    restoreCanvas();
    document.body.innerHTML = "";
  });

  it("matches the committed baseline in every state", async () => {
    const live: MarkupBaseline = {
      axeVersion: axe.version,
      states: AUDIT_STATES.map((state) => state.id),
      results: { datum: await auditBinding() }
    };
    if (process.env.A11Y_UPDATE) {
      writeFileSync(BASELINE_URL, `${JSON.stringify(live, null, 2)}\n`);
      return;
    }
    const baseline = readBaseline();
    expect(baseline, "no baseline: run `A11Y_UPDATE=1 npx vitest run tests/a11y-markup.test.ts`").toBeDefined();
    for (const state of AUDIT_STATES) {
      expect(
        live.results.datum![state.id],
        `Datum's binding in state "${state.id}" drifted from a11y/baseline/markup.json — look, then A11Y_UPDATE=1 to accept`
      ).toEqual(baseline!.results.datum?.[state.id]);
    }
    expect(live.axeVersion).toBe(baseline!.axeVersion);
  }, 300_000);
});

/**
 * A journey page's markup: what the renderer adds around a page's questions — the
 * heading focus moves to on every page change, Back, the one action under the questions — and
 * axe's WCAG rules over it, with Datum's binding. Not part of the baseline above:
 * the fixture form has no journey, and this page's own structure is asserted outright.
 */
describe("the journey page markup", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function journeyForm(): FormDefinition {
    return {
      id: "journey-a11y",
      version: "1.0.0",
      schemaVersion: "1",
      root: {
        id: "root",
        type: "form",
        configuration: { title: "Permit application" },
        children: {
          content: [
            { id: "fullName", type: "text", configuration: { label: "Full name", required: true } },
            { id: "email", type: "text", configuration: { label: "Email", required: true } }
          ]
        }
      },
      journey: {
        journeys: [
          {
            id: "apply",
            progress: "count",
            pages: [
              { id: "name", title: "Your name", components: ["fullName"] },
              { id: "contact", title: "How to reach you", description: "We only write about this application.", components: ["email"] }
            ]
          }
        ]
      }
    };
  }

  it("heads each page with a heading focus can move to, draws Back as a button and one action under the questions, and passes axe", async () => {
    const element = document.createElement("datum-form") as DatumFormElement;
    element.definition = journeyForm();
    document.body.append(element);
    await until(() => element.renderer?.shadowRoot?.querySelector("[data-journey-heading]"));
    const root = element.renderer!.shadowRoot!;
    const buttons = () => [...root.querySelectorAll<HTMLButtonElement>("form button")].map((button) => `${button.getAttribute("type")}:${button.textContent!.trim()}`);

    // The first page: a heading focus can move to, no Back, one action under the questions.
    const heading = root.querySelector<HTMLElement>("[data-journey-heading]")!;
    expect(heading.matches("h1, h2, h3")).toBe(true);
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(heading.textContent).toBe("Step 1 of 2: Your name");
    expect(root.querySelector("form")!.contains(heading)).toBe(true);
    expect(root.querySelector("[data-journey-back]")).toBeNull();
    expect(buttons()).toEqual(["button:Continue"]);

    element.runtime!.setValue("fullName", "Ada Lovelace");
    await element.nextPage();
    await until(() => root.querySelector("[data-journey-heading]")?.textContent?.includes("How to reach you"));
    // The last page: a described heading, Submit as the one action, Back as a button of its own.
    const back = root.querySelector<HTMLElement>("[data-journey-back]")!;
    expect(back.tagName).toBe("BUTTON");
    expect(back.getAttribute("type")).toBe("button");
    expect(back.textContent).toBe("Back");
    expect(root.querySelector("form p")?.textContent).toBe("We only write about this application.");
    expect(buttons().sort()).toEqual(["button:Back", "button:Submit"]);
    expect(root.querySelector("[data-journey-continue]")?.textContent).toBe("Submit");

    const results = await axe.run(element, axeRunOptions({ colour: false }) as axe.RunOptions);
    expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.length}`)).toEqual([]);
  }, 30_000);

  it("heads a journey that hides its page heading with the form's title alone, gives focus the page's form, and passes axe", async () => {
    const definition = journeyForm();
    const journey = definition.journey!.journeys![0]!;
    definition.journey = { journeys: [{ ...journey, heading: "hidden" }] };
    // The form's title as its own chrome draws it: the element draws no other (as for the whole form).
    (definition.root.configuration as Record<string, unknown>).chrome = { header: [{ id: "title", type: "form-title" }] };
    const element = document.createElement("datum-form") as DatumFormElement;
    element.definition = definition;
    document.body.append(element);
    await until(() => element.renderer?.shadowRoot?.querySelector("[data-journey-page-focus]"));
    const root = element.renderer!.shadowRoot!;

    expect(root.querySelector("[data-journey-heading]")).toBeNull();
    const headings = root.querySelectorAll("h1");
    expect(headings).toHaveLength(1);
    expect(headings[0]!.textContent).toBe("Permit application");
    const pageForm = root.querySelector("form")!;
    expect(pageForm.hasAttribute("aria-labelledby")).toBe(false);
    expect(pageForm.getAttribute("tabindex")).toBe("-1");
    expect(pageForm.getAttribute("data-journey-page-focus")).toBe("");

    element.runtime!.setValue("fullName", "Ada Lovelace");
    await element.nextPage();
    await until(() => root.querySelector("[data-journey-back]"));
    // The last page: the title stays in the header, the page's description leads its questions.
    expect(root.querySelectorAll("h1")).toHaveLength(1);
    expect(root.querySelector("form p")?.textContent).toBe("We only write about this application.");

    const results = await axe.run(element, axeRunOptions({ colour: false }) as axe.RunOptions);
    expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.length}`)).toEqual([]);
  }, 30_000);
});

