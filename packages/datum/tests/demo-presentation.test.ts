import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import "../src/form.js";
import type { DatumFormElement, LiveBinding } from "../src/form.js";

import { until } from "./helpers.js";

/**
 * A fixture binding with wording of its own for a required answer and a summary entry that is
 * the message alone, as a design system that words each error for its question has it: what a
 * page switches to by setting `binding`.
 */
const WORDED_BINDING: LiveBinding = {
  id: "worded",
  label: "Worded",
  components: {},
  texts: { en: { summaryEntry: "{{message}}" } },
  messages: { en: { required: "Enter an answer" } }
};

/*
 * demo/presentation.html: the page's own script, run against the element from
 * source, so the showcase keeps working — the presentations it offers, and its panel showing
 * what is submitted beside what stays in the browser. The bundles the page loads are left out.
 */

const html = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../demo/presentation.html"), "utf8");

afterEach(async () => {
  await (document.getElementById("form") as DatumFormElement | null)?.clearDraft();
  document.body.innerHTML = "";
});

function loadDemo(): DatumFormElement {
  const body = html.slice(html.indexOf("<body>") + "<body>".length, html.indexOf("</body>"));
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(body)?.[1];
  expect(script).toBeDefined();
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, "");
  new Function(script!)();
  return document.getElementById("form") as DatumFormElement;
}

const panel = (id: string): unknown => JSON.parse(document.getElementById(id)!.textContent ?? "{}");

/** The form as drawn: the renderer's shadow root. */
const drawn = (form: DatumFormElement): ShadowRoot | null | undefined => form.renderer?.shadowRoot;

/** The heading of the journey page shown, once it has painted ("Page 1 of 2: Your details" under a count). */
const heading = (form: DatumFormElement): string | undefined =>
  drawn(form)?.querySelector<HTMLElement>("[data-journey-heading]")?.textContent?.trim();

/** The page headed `title` has painted. */
const shows = (form: DatumFormElement, title: string): boolean => heading(form)?.endsWith(title) === true;

/**
 * Fills every box the page draws, as a person types: a number box a number, any other a
 * line of text. Nothing the page does not draw is filled, so a required field a
 * presentation leaves out stays empty.
 */
function fillDrawn(form: DatumFormElement): string[] {
  const filled: string[] = [];
  for (const input of drawn(form)?.querySelectorAll<HTMLInputElement>("input:not([type=hidden]):not([readonly]):not([disabled])") ?? []) {
    input.value = input.type === "number" || input.inputMode === "numeric" || input.inputMode === "decimal" ? "1200" : "ada@example.org";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    filled.push(input.id);
  }
  return filled;
}

/** Picks a presentation from the page's own picker, as a person does. */
async function choose(id: string): Promise<void> {
  const select = document.getElementById("journey") as HTMLSelectElement;
  await until(() => select.options.length === 4);
  select.value = id;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("demo/presentation.html", () => {
  it("offers each presentation, and shows the form's values apart from the ones kept in the browser", async () => {
    const form = loadDemo();
    await until(() => form.page === "details");
    const select = document.getElementById("journey") as HTMLSelectElement;
    await until(() => select.options.length === 4);
    expect([...select.options].map((option) => option.textContent)).toEqual(["Form's choice", "Whole form", "Apply", "Public"]);

    form.runtime!.setValue("email", "ada@example.org");
    form.runtime!.setValue("@apply.greeting", "Ada");
    expect((await form.nextPage()).pageId).toBe("income");
    form.runtime!.setValue("@apply.m1", 1000);
    form.runtime!.setValue("@apply.m2", 2000);
    await until(() => (panel("own-values") as Record<string, unknown>).m2 === 2000);
    expect(panel("own-values")).toEqual({ greeting: "Ada", m1: 1000, m2: 2000 });
    expect(panel("form-values")).toEqual({ email: "ada@example.org", annual_income: 3000 });
  });

  // Each presentation is filled through what it draws, and nothing else: a presentation that
  // leaves a required field of the form out could never be submitted.
  it("lets the Public one-page journey be submitted: it asks the required Annual income too", async () => {
    const form = loadDemo();
    await until(() => form.page === "details");
    await choose("public");
    // Its page heading is hidden: the page itself, the form's title over it.
    await until(() => form.page === "all" && drawn(form)?.querySelector("[data-journey-page-focus]") && !heading(form));
    expect(drawn(form)!.querySelector("#annual_income")).not.toBeNull();
    expect(fillDrawn(form)).toEqual(expect.arrayContaining(["email", "annual_income"]));
    await until(() => form.values.annual_income === 1200);
    const result = await form.submit();
    expect(result.errors.map((error) => `${error.componentId}:${error.code}`)).toEqual([]);
    expect(result.accepted).toBe(true);
  });

  it("lets the Apply journey and the whole form be submitted, each filled through what it draws", async () => {
    const form = loadDemo();
    await until(() => shows(form, "Your details"));
    fillDrawn(form);
    await until(() => form.values.email === "ada@example.org");
    expect((await form.nextPage()).ok).toBe(true);
    await until(() => shows(form, "Your income"));
    fillDrawn(form);
    // Three months of 1200 work out an annual income under the line: the journey ends here.
    await until(() => form.values.annual_income === 3600);
    expect((await form.submit()).accepted).toBe(true);

    await form.clearDraft();
    document.body.innerHTML = "";
    const whole = loadDemo();
    await until(() => whole.page === "details");
    await choose("form");
    await until(() => heading(whole) === undefined && drawn(whole)?.querySelector("#approved_amount"));
    fillDrawn(whole);
    await until(() => whole.values.annual_income === 1200);
    expect((await whole.submit()).accepted).toBe(true);
  });
});

describe("demo/presentation.html: a required field a presentation leaves out", () => {
  it("is named in the error summary by its label, under a binding's own wording too, beside the page's own linked entry", async () => {
    // The demo's form with the Public variant as it stood before it asked Annual income: Email
    // and Name only. The error on the field it leaves out has no field on the page to go to.
    const form = loadDemo();
    await until(() => form.page === "details");
    const definition = structuredClone(form.definition!);
    const all = definition.journey!.journeys!.find((journey) => journey.id === "public")!.pages[0]!;
    all.components = all.components!.filter((component) => component !== "money");
    form.definition = definition;
    await choose("public");
    // Its page heading is hidden: the page itself, the form's title over it.
    await until(() => form.page === "all" && drawn(form)?.querySelector("[data-journey-page-focus]") && !heading(form));

    const summary = (): string[] =>
      [...(drawn(form)?.querySelectorAll<HTMLElement>("[role=alert][tabindex='-1'] li") ?? [])].map((item) => item.textContent!.trim());
    expect((await form.submit()).accepted).toBe(false);
    await until(() => summary().length === 2);
    // The engine words `required` itself, so the bare code never shows.
    expect(summary()).toEqual(["Annual income: This field is required", "Email: This field is required"]);

    form.binding = WORDED_BINDING;
    await until(() => summary().includes("Annual income: Enter an answer"));
    expect(summary()).toEqual(["Annual income: Enter an answer", "Enter an answer"]);
    expect(drawn(form)!.querySelector("a[href='#email']")?.textContent?.trim()).toBe("Enter an answer");
  });
});
