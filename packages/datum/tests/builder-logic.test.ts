import { afterEach, describe, expect, it, vi } from "vitest";
import { BuilderController, BuilderPreviewRuntime, addressOf } from "@argusvane/datum-engine";
import type { Expression, FormDefinition } from "@argusvane/datum-engine";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * The Logic workspace with the formula builder: every
 * rule as a sentence, the rule editor as one formula box, Apply as one undo step, the leave
 * guard, Try it, the run scopes, and the textarea fallback when the editor's chunk fails.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

/** The Logic element's test seams: the editor loader is public so a test can make it fail. */
interface LogicSurface extends HTMLElement {
  formulaEditorLoader: () => Promise<unknown>;
  openableDocuments: { pdf?: boolean; journeys?: boolean };
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const surfaceElement = (element: DatumFormBuilderElement): LogicSurface | undefined =>
  (shell(element).querySelector("datum-builder-logic") as LogicSurface | null) ?? undefined;
const surface = (element: DatumFormBuilderElement): ShadowRoot | undefined => surfaceElement(element)?.shadowRoot ?? undefined;
const logic = (element: DatumFormBuilderElement): ShadowRoot => surface(element)!;
const fire = (target: Element, type: "input" | "change" | "blur"): void => {
  target.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
};

/** The editor's chunk never lands: the plain box stays. Most tests type into it, since it is the one box jsdom can type into. */
const offline = (): Promise<never> => Promise.reject(new Error("offline"));

/** The surface's own loader (the real chunk), captured before a test swaps it out. */
let realLoader: (() => Promise<unknown>) | undefined;

async function mountInLogic(editorLoader: (() => Promise<unknown>) | null = offline): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = sampleDefinition();
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  element.builder!.setWorkspace("logic");
  await until(() => surface(element)?.querySelector("[data-logic-rule]"));
  realLoader ??= surfaceElement(element)!.formulaEditorLoader;
  if (editorLoader) {
    surfaceElement(element)!.formulaEditorLoader = editorLoader;
  }
  return element;
}

const ruleCard = (element: DatumFormBuilderElement): HTMLButtonElement =>
  logic(element).querySelector<HTMLButtonElement>('[data-logic-rule="form:email:visibleWhen"]')!;

const box = (element: DatumFormBuilderElement): HTMLTextAreaElement => logic(element).querySelector<HTMLTextAreaElement>(".formula-textarea")!;

const apply = (element: DatumFormBuilderElement): HTMLButtonElement => logic(element).querySelector<HTMLButtonElement>("[data-logic-apply]")!;

/** The problem under the formula box before Try it; the summary line above Apply repeats it. */
const problemLine = (element: DatumFormBuilderElement): HTMLElement => logic(element).querySelector<HTMLElement>("[data-logic-problem]")!;

const readsAs = (element: DatumFormBuilderElement): string =>
  [...logic(element).querySelector("[data-logic-reads]")!.children].map((token) => token.textContent).join(" ");

function type(element: DatumFormBuilderElement, text: string): void {
  const input = box(element);
  input.value = text;
  fire(input, "input");
}

function nodeOf(element: DatumFormBuilderElement, id: string): Record<string, unknown> {
  return element.builder!.controller.snapshot().children!.content!.find((node) => node.id === id) as unknown as Record<string, unknown>;
}

async function startNew(element: DatumFormBuilderElement, kind: string, target: string): Promise<void> {
  logic(element).querySelector<HTMLButtonElement>("[data-logic-new]")!.click();
  logic(element).querySelector<HTMLButtonElement>(`[data-logic-new-kind="${kind}"]`)!.click();
  const select = logic(element).querySelector<HTMLSelectElement>("[data-logic-target]")!;
  select.value = target;
  fire(select, "change");
  await until(() => box(element));
}

describe("the Logic workspace", () => {
  it("draws its surface in the canvas's place, with no drawer open, listing the form's rules as sentences", async () => {
    const element = await mountInLogic();
    expect(shell(element).querySelector("[data-shell=wrap]")!.getAttribute("data-workspace")).toBe("logic");
    expect(shell(element).querySelector<HTMLElement>("[data-logic-host]")!.hidden).toBe(false);
    expect(element.builder!.panel).toBeUndefined();
    const card = ruleCard(element);
    expect(card.querySelector(".verb")!.textContent).toBe("Show");
    expect([...card.querySelectorAll(".token--field")].map((token) => token.textContent)).toEqual(["Email", "Subscribe"]);
    const all = logic(element).querySelector('[data-logic-filter="all"]')!;
    expect(all.getAttribute("aria-pressed")).toBe("true");
    expect(all.querySelector(".filter-count")!.textContent).toBe("1");
    expect(logic(element).querySelector('[data-logic-filter="require"] .filter-count')!.textContent).toBe("0");
    // Show, Hide, Require, Validate, Calculate, Start at; no Show step without steps.
    expect(logic(element).querySelectorAll('[data-logic-new-kind]').length).toBe(6);
    expect(logic(element).querySelector('[data-logic-new-kind="validate"] strong')!.textContent).toBe("Validate a field");
    expect(logic(element).querySelector('[data-logic-new-kind="hide"] strong')!.textContent).toBe("Hide a field");
    expect(logic(element).querySelector('[data-logic-new-kind="default"] strong')!.textContent).toBe("Start a field at a value");
  });

  it("lists the Journeys and PDF filters only for the features the builder has", async () => {
    const element = await mountInLogic();
    const filters = (): string[] => [...logic(element).querySelectorAll<HTMLElement>("[data-logic-filter]")].map((f) => f.dataset.logicFilter!);
    expect(filters()).toContain("pdf");
    expect(filters()).toContain("journeys");
    surfaceElement(element)!.openableDocuments = { pdf: false, journeys: false };
    expect(filters()).not.toContain("pdf");
    expect(filters()).not.toContain("journeys");
    expect(filters()).toContain("steps");
  });

  it("hides the surface again in Form", async () => {
    const element = await mountInLogic();
    element.builder!.setWorkspace("form");
    expect(shell(element).querySelector<HTMLElement>("[data-logic-host]")!.hidden).toBe(true);
  });

  it("opens a tree-stored rule as text, selecting its field, and applies a change beside it without rewriting the tree", async () => {
    const element = await mountInLogic();
    const controller = element.builder!.controller;
    ruleCard(element).click();
    expect(controller.selectedComponentId()).toBe("email");
    const editor = logic(element).querySelector("[data-logic-editor]")!;
    expect(editor.querySelector("h2")!.textContent).toBe("Show a field");
    expect(editor.querySelector(".field-pick")!.textContent).toBe("Email");
    expect(editor.querySelector("[data-logic-run-btn] span")!.textContent).toBe("Browser and server");
    expect(editor.querySelector("#logic-formula-lead")!.textContent).toBe("Show Email when");
    expect(box(element).value).toBe("subscribe");
    expect(readsAs(element)).toBe("Show Email when Subscribe is ticked");
    expect(apply(element).disabled).toBe(true);

    const clear = logic(element).querySelector<HTMLInputElement>('[data-logic-hidden][value="clear"]')!;
    clear.checked = true;
    fire(clear, "change");
    expect(apply(element).disabled).toBe(false);
    expect(logic(element).querySelector<HTMLElement>("[data-logic-dirty]")!.hidden).toBe(false);
    apply(element).click();
    const email = (): Record<string, unknown> => nodeOf(element, "email").configuration as Record<string, unknown>;
    expect(email().hiddenValueBehavior).toBe("clear");
    // The rule itself was not edited: the tree stays a tree, byte for byte.
    expect((nodeOf(element, "email").rules as Record<string, unknown>).visibleWhen).toEqual({ kind: "path", path: "subscribe" });
    await until(() => logic(element).querySelector(".chip")?.textContent === "Sent empty when hidden");
    controller.undo();
    expect(email().hiddenValueBehavior).toBeUndefined();
  });

  it("writes a tree-stored rule back as a string once its text is edited, as one undo step", async () => {
    const element = await mountInLogic();
    const controller = element.builder!.controller;
    ruleCard(element).click();
    type(element, 'subscribe and fullName = "Ada"');
    expect(readsAs(element)).toBe("Show Email when Subscribe is ticked and Full name is Ada");
    expect(apply(element).disabled).toBe(false);
    apply(element).click();
    expect((nodeOf(element, "email").rules as Record<string, unknown>).visibleWhen).toBe('subscribe and fullName = "Ada"');
    await until(() => ruleCard(element).querySelectorAll(".token--field").length === 3);
    controller.undo();
    expect((nodeOf(element, "email").rules as Record<string, unknown>).visibleWhen).toEqual({ kind: "path", path: "subscribe" });
    await until(() => box(element).value === "subscribe");
  });

  it("keeps a Show rule over not(...) as Show after Apply, and says the kind it saves", async () => {
    const element = await mountInLogic();
    await startNew(element, "show", "country");
    expect(logic(element).querySelector("[data-logic-saved-as]")!.textContent).toBe("Saved as: Show");
    type(element, "not(empty(fullName))");
    apply(element).click();
    const stored = (nodeOf(element, "country").rules as Record<string, unknown>).visibleWhen;
    expect(stored).toBe("not(empty(fullName))");
    const card = (): HTMLButtonElement => logic(element).querySelector<HTMLButtonElement>('[data-logic-rule="form:country:visibleWhen"]')!;
    await until(() => card());
    card().click();
    await until(() => logic(element).querySelector("[data-logic-editor]"));
    expect(logic(element).querySelector("[data-logic-editor]")!.getAttribute("data-logic-kind")).toBe("show");
    expect(box(element).value).toBe("not(empty(fullName))");
    expect(card().querySelector(".verb")!.textContent).toBe("Show");
    // Opening and discarding writes nothing.
    logic(element).querySelector<HTMLButtonElement>("[data-logic-discard]")!.click();
    expect((nodeOf(element, "country").rules as Record<string, unknown>).visibleWhen).toBe(stored);
  });

  it("forgets the kinds noted for one form when another is opened", async () => {
    const element = await mountInLogic();
    await startNew(element, "show", "country");
    type(element, "not(empty(fullName))");
    apply(element).click();
    const stored = (nodeOf(element, "country").rules as Record<string, unknown>).visibleWhen;
    expect(stored).toBe("not(empty(fullName))");
    // A different form with the same field and the same rule text.
    const other = sampleDefinition();
    const country = other.root.children!.content!.find((node) => node.id === "country")!;
    country.rules = { visibleWhen: stored } as never;
    element.definition = other;
    const card = (): HTMLButtonElement | null => logic(element).querySelector<HTMLButtonElement>('[data-logic-rule="form:country:visibleWhen"]');
    await until(() => card() !== null && card()!.querySelector(".verb")?.textContent === "Hide");
    expect(card()!.querySelector(".verb")!.textContent).toBe("Hide");
  });

  it("reads a Hide rule as Hide and states it", async () => {
    const element = await mountInLogic();
    await startNew(element, "hide", "country");
    expect(logic(element).querySelector("[data-logic-saved-as]")!.textContent).toBe("Saved as: Hide");
  });

  it("offers value chips, not yes/no chips, for a Calculate rule", async () => {
    const element = await mountInLogic();
    await startNew(element, "calculate", "fullName");
    const chips = [...logic(element).querySelectorAll<HTMLElement>("[data-logic-try-one]")].map((chip) => chip.dataset.logicTryOne!);
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.some((chip) => chip.startsWith("not(empty("))).toBe(false);
    expect(chips.some((chip) => / > 10$/.test(chip))).toBe(false);
  });

  it("says Choose the field once, and keeps Discard enabled while the formula is invalid", async () => {
    const element = await mountInLogic();
    logic(element).querySelector<HTMLButtonElement>("[data-logic-new]")!.click();
    logic(element).querySelector<HTMLButtonElement>('[data-logic-new-kind="show"]')!.click();
    const text = logic(element).querySelector<HTMLElement>("[data-logic-editor]")!.textContent!;
    expect(text.split("Choose the field this rule is for.").length - 1).toBe(1);
    logic(element).querySelector<HTMLButtonElement>("[data-logic-discard]")!.click();
    ruleCard(element).click();
    type(element, "subscribe and");
    const discard = logic(element).querySelector<HTMLButtonElement>("[data-logic-discard]")!;
    expect(discard.disabled).toBe(false);
    discard.click();
    expect(logic(element).querySelector("[data-logic-editor]")).toBeNull();
    expect((nodeOf(element, "email").rules as Record<string, unknown>).visibleWhen).toEqual({ kind: "path", path: "subscribe" });
    ruleCard(element).click();
    await until(() => box(element));
    expect(box(element).value).toBe("subscribe");
  });

  it("writes a new rule from New rule as a formula string", async () => {
    const element = await mountInLogic();
    await startNew(element, "require", "fullName");
    expect(logic(element).querySelector("#logic-formula-lead")!.textContent).toBe("Require Full name when");
    expect(logic(element).querySelectorAll("[data-logic-try-one]").length).toBeGreaterThan(0);
    type(element, "subscribe");
    expect(logic(element).querySelectorAll("[data-logic-try-one]").length).toBe(0);
    apply(element).click();
    expect((nodeOf(element, "fullName").rules as Record<string, unknown>).requiredWhen).toBe("subscribe");
    await until(() => logic(element).querySelector('[data-logic-rule="form:fullName:requiredWhen"]'));
    expect(logic(element).querySelector('[data-logic-filter="require"] .filter-count')!.textContent).toBe("1");
  });

  it("stores a Hide rule as not(…) and lists it as Hide", async () => {
    const element = await mountInLogic();
    await startNew(element, "hide", "country");
    expect(logic(element).querySelector("#logic-formula-lead")!.textContent).toBe("Hide Country when");
    type(element, 'fullName = "Ada"');
    expect(readsAs(element)).toBe("Hide Country when Full name is Ada");
    apply(element).click();
    expect((nodeOf(element, "country").rules as Record<string, unknown>).visibleWhen).toBe('not(fullName = "Ada")');
    await until(() => logic(element).querySelector('[data-logic-rule="form:country:visibleWhen"]'));
    const card = logic(element).querySelector('[data-logic-rule="form:country:visibleWhen"]')!;
    expect(card.querySelector(".verb")!.textContent).toBe("Hide");
    // Opened again, the box holds the condition without its not(…).
    expect(box(element).value).toBe('fullName = "Ada"');
  });

  it("stores a Start-at rule with the fixed Browser chip, and tries a value rule beside it", async () => {
    const element = await mountInLogic();
    await startNew(element, "default", "fullName");
    expect(logic(element).querySelector("[data-logic-run-fixed]")!.textContent).toBe("Browser");
    expect(logic(element).querySelector("[data-logic-run-btn]")).toBeNull();
    expect(box(element).getAttribute("aria-multiline")).toBe("true");
    type(element, 'if subscribe then "yes" else "no"');
    expect(readsAs(element)).toBe("Start Full name at yes when Subscribe is ticked, otherwise no");
    // A value chip before the comma takes it beside itself, not in a gap.
    type(element, 'if fullName = "Ada" then "yes" else "no"');
    expect(readsAs(element)).toBe("Start Full name at yes when Full name is Ada, otherwise no");
    expect(logic(element).querySelector("[data-logic-reads] .with-mark")!.innerHTML).toBe('<span class="ref-chip token--value">Ada</span>,');
    type(element, 'if subscribe then "yes" else "no"');
    const result = (): string => logic(element).querySelector("[data-logic-try-result]")!.textContent!;
    expect(result()).toBe("Full name is noon both sides");
    const tick = logic(element).querySelector<HTMLInputElement>('[data-logic-try="subscribe"]')!;
    tick.checked = true;
    fire(tick, "change");
    expect(result()).toBe("Full name is yeson both sides");
    apply(element).click();
    expect((nodeOf(element, "fullName").rules as Record<string, unknown>).defaultValue).toBe('if subscribe then "yes" else "no"');
  });

  it("shows a parse problem under the box and above Apply, which leads to it rather than writing", async () => {
    const element = await mountInLogic();
    ruleCard(element).click();
    type(element, "subscribe and");
    expect(box(element).getAttribute("aria-invalid")).toBe("true");
    expect(logic(element).querySelector(".formula-fallback .problem")!.textContent).toContain("A value is missing");
    // One message, not two: the copy above Apply was removed.
    expect(logic(element).querySelector("[data-logic-summary]")).toBeNull();
    const problem = problemLine(element);
    expect(problem.hidden).toBe(false);
    expect(problem.dataset.severity).toBe("error");
    expect(problem.getAttribute("role")).toBe("alert");
    expect(problem.id).toBe("logic-problem");
    expect(problem.textContent).toContain("A value is missing");
    expect(apply(element).getAttribute("aria-describedby")).toBe("logic-problem");
    // It sits directly under the box, before "Reads as" and Try it; the summary line is the repeat for the eye.
    expect(problem.closest(".formula-row")).not.toBeNull();
    expect(problem.previousElementSibling).toBe(logic(element).querySelector("[data-logic-formula-slot]"));
    expect(problem.compareDocumentPosition(logic(element).querySelector("[data-logic-reads]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(apply(element).disabled).toBe(false);
    apply(element).click();
    expect((nodeOf(element, "email").rules as Record<string, unknown>).visibleWhen).toEqual({ kind: "path", path: "subscribe" });
    expect(logic(element).querySelector("[data-logic-editor]")).not.toBeNull();
    // Fixed, Apply writes it as one undo step, and undo brings the tree back.
    type(element, "subscribe and country = \"CA\"");
    expect(problemLine(element).hidden).toBe(true);
    apply(element).click();
    expect((nodeOf(element, "email").rules as Record<string, unknown>).visibleWhen).toBe('subscribe and country = "CA"');
    element.builder!.controller.undo();
    expect((nodeOf(element, "email").rules as Record<string, unknown>).visibleWhen).toEqual({ kind: "path", path: "subscribe" });
  });

  it("warns about a field the form does not have, with the nearest name, and still applies", async () => {
    const element = await mountInLogic();
    ruleCard(element).click();
    type(element, "subscrib");
    expect(box(element).getAttribute("aria-invalid")).toBeNull();
    expect(problemLine(element).textContent).toContain("No field is called subscrib. Did you mean Subscribe?");
    expect(problemLine(element).hidden).toBe(false);
    expect(problemLine(element).dataset.severity).toBe("warning");
    expect(problemLine(element).getAttribute("role")).toBeNull();
    expect(problemLine(element).querySelector("[data-logic-problem-text]")!.textContent).toBe("No field is called subscrib. Did you mean Subscribe?");
    // The Reads as line draws the unknown field in the danger wash, not as an ordinary field chip.
    const unknown = logic(element).querySelector<HTMLElement>("[data-logic-reads] .token--unknown")!;
    expect(unknown.textContent).toBe("subscrib");
    expect(unknown.classList.contains("token--field")).toBe(true);
    const fieldTokens = [...logic(element).querySelectorAll("[data-logic-reads] .token--field")];
    expect(fieldTokens.map((token) => `${token.textContent}:${token.classList.contains("token--unknown")}`)).toEqual(["Email:false", "subscrib:true"]);
    apply(element).click();
    expect((nodeOf(element, "email").rules as Record<string, unknown>).visibleWhen).toBe("subscrib");
    await until(() => logic(element).querySelector('[data-logic-diagnostic="reads-missing-field"]'));
    expect(logic(element).querySelector('[data-logic-diagnostic="reads-missing-field"]')!.textContent).toContain("Email's rule reads subscrib, which no field in the form stores.");
  });

  it("sets where the rule runs, writing the object form and chips on the card", async () => {
    const element = await mountInLogic();
    ruleCard(element).click();
    logic(element).querySelector<HTMLButtonElement>("[data-logic-run-btn]")!.click();
    const menu = logic(element).querySelector<HTMLElement>("[data-logic-run-menu]")!;
    expect(menu.hidden).toBe(false);
    expect([...menu.querySelectorAll("strong")].map((item) => item.textContent)).toEqual(["Browser and server", "Browser only", "Server only", "Server only, secret"]);
    logic(element).querySelector<HTMLButtonElement>('[data-logic-run="server"]')!.click();
    expect(logic(element).querySelector("[data-logic-run-btn] span")!.textContent).toBe("Server only");
    expect(readsAs(element)).toBe("Show Email when Subscribe is ticked");
    apply(element).click();
    expect((nodeOf(element, "email").rules as Record<string, unknown>).visibleWhen).toEqual({ formula: "subscribe", run: "server" });
    await until(() => logic(element).querySelector('[data-logic-run-chip="server"]'));
    expect(logic(element).querySelector("[data-logic-try-result] .side")!.textContent).toBe("server only");

    logic(element).querySelector<HTMLButtonElement>("[data-logic-run-btn]")!.click();
    logic(element).querySelector<HTMLButtonElement>('[data-logic-run="server-secret"]')!.click();
    expect(logic(element).querySelector("[data-logic-secret-note]")!.textContent).toContain("A PDF printed from the browser leaves this field blank.");
    expect(readsAs(element)).toBe("Show Email when a formula the server keeps");
    apply(element).click();
    expect((nodeOf(element, "email").rules as Record<string, unknown>).visibleWhen).toEqual({ formula: "subscribe", run: "server-secret" });
    await until(() => logic(element).querySelector('[data-logic-run-chip="server-secret"]'));
    expect(logic(element).querySelector('[data-logic-run-chip="server-secret"]')!.textContent).toBe("Server only, secret");
    expect(ruleCard(element).textContent).toContain("a formula the server keeps");
  });

  it("agrees with the inspector on one key: Kept and sent in the editor is retain in the field, and the default through the inspector clears the key", async () => {
    const element = await mountInLogic();
    const controller = element.builder!.controller;
    const email = (): Record<string, unknown> => nodeOf(element, "email").configuration as Record<string, unknown>;
    const whenHidden = (): { value: unknown; choices: Array<{ value: string; label: string }> } | undefined =>
      controller.inspectorModel("email")!.sections.flatMap((section) => section.fields).find((field) => field.propertyPath === "hiddenValueBehavior");

    ruleCard(element).click();
    // Nothing set: the default is checked and the inspector shows the default choice.
    expect(logic(element).querySelector<HTMLInputElement>('[data-logic-hidden][value="exclude-from-submission"]')!.checked).toBe(true);
    expect(whenHidden()!.value).toBe("exclude-from-submission");
    expect(whenHidden()!.choices.map((choice) => choice.value)).toEqual(["exclude-from-submission", "retain", "clear"]);

    const sent = logic(element).querySelector<HTMLInputElement>('[data-logic-hidden][value="retain"]')!;
    sent.checked = true;
    fire(sent, "change");
    apply(element).click();
    expect(email().hiddenValueBehavior).toBe("retain");
    expect(whenHidden()!.value).toBe("retain");

    // Back to the default by the inspector's path: the key goes, and the Logic editor follows.
    controller.setDraftProperty("email", "hiddenValueBehavior", "exclude-from-submission");
    expect(controller.commitDraft("email")).toBe(true);
    expect(email()).not.toHaveProperty("hiddenValueBehavior");
    expect(whenHidden()!.value).toBe("exclude-from-submission");
    // The editor still open, and clean, follows the stored key at once.
    await until(() => logic(element).querySelector<HTMLInputElement>('[data-logic-hidden][value="exclude-from-submission"]')?.checked === true);
    expect(logic(element).querySelector<HTMLInputElement>('[data-logic-hidden][value="retain"]')!.checked).toBe(false);
    expect(logic(element).querySelector<HTMLElement>("[data-logic-dirty]")!.hidden).toBe(true);
    // Closed and opened again, it reads the same.
    logic(element).querySelector<HTMLButtonElement>("[data-logic-discard]")!.click();
    await until(() => logic(element).querySelector("[data-logic-editor]") === null);
    ruleCard(element).click();
    await until(() => logic(element).querySelector('[data-logic-hidden][value="exclude-from-submission"]'));
    expect(logic(element).querySelector<HTMLInputElement>('[data-logic-hidden][value="exclude-from-submission"]')!.checked).toBe(true);
    expect(logic(element).querySelector<HTMLInputElement>('[data-logic-hidden][value="retain"]')!.checked).toBe(false);
    expect(logic(element).querySelector<HTMLElement>("[data-logic-dirty]")!.hidden).toBe(true);
  });

  it("asks before a workspace switch walks past a rule not applied, and Stay keeps it", async () => {
    const element = await mountInLogic();
    ruleCard(element).click();
    // The default is leaving the answer out, so a change from it is keeping and sending the answer.
    const kept = logic(element).querySelector<HTMLInputElement>('[data-logic-hidden][value="retain"]')!;
    kept.checked = true;
    fire(kept, "change");
    // The host's own check counts it too (a host's status line and leave-page warning).
    expect(element.hasUnsavedChanges()).toBe(true);
    element.builder!.setWorkspace("form");
    expect(element.builder!.workspace).toBe("logic");
    await until(() => logic(element).querySelector("[data-unsaved-prompt]"));
    expect(logic(element).querySelector("[data-unsaved-prompt]")!.textContent).toContain("Show a field: Email");
    logic(element).querySelector<HTMLButtonElement>("[data-unsaved-stay]")!.click();
    expect(element.builder!.workspace).toBe("logic");
    expect(logic(element).querySelector("[data-unsaved-prompt]")).toBeNull();

    element.builder!.setWorkspace("form");
    await until(() => logic(element).querySelector("[data-unsaved-discard]"));
    logic(element).querySelector<HTMLButtonElement>("[data-unsaved-discard]")!.click();
    expect(element.builder!.workspace).toBe("form");
  });

  it("creates a Validate rule with its message in one Apply, tries it, and reads both back", async () => {
    const element = await mountInLogic();
    const controller = element.builder!.controller;
    await startNew(element, "validate", "fullName");
    const editor = logic(element).querySelector("[data-logic-editor]")!;
    expect(editor.querySelector("h2")!.textContent).toBe("Validate a field");
    expect(editor.querySelector("#logic-formula-lead")!.textContent).toBe("Accept Full name only when");
    type(element, 'fullName != "Bob"');
    expect(readsAs(element)).toBe("Accept Full name only when Full name is not Bob");
    const message = logic(element).querySelector<HTMLInputElement>("[data-logic-message]")!;
    expect(logic(element).querySelector("#logic-message-hint")!.textContent).toContain("Check this answer");
    message.value = "Anyone but Bob.";
    fire(message, "input");
    // Typing the message repaints nothing: the box is the same element.
    expect(logic(element).querySelector("[data-logic-message]")).toBe(message);

    // Try it, beside the rule: the field's own box, the fold's verdict.
    const result = (): string => logic(element).querySelector("[data-logic-try-result] span")!.textContent!;
    const own = logic(element).querySelector<HTMLInputElement>('[data-logic-try="fullName"]')!;
    expect(result()).toBe("Full name is empty, so it is not checked");
    own.value = "Bob";
    fire(own, "input");
    expect(result()).toBe("Full name is refused: Anyone but Bob.");
    logic(element).querySelector<HTMLInputElement>('[data-logic-try="fullName"]')!.value = "Ada";
    fire(logic(element).querySelector<HTMLInputElement>('[data-logic-try="fullName"]')!, "input");
    expect(result()).toBe("Full name is accepted");

    apply(element).click();
    const fullName = (): Record<string, unknown> => nodeOf(element, "fullName");
    expect((fullName().rules as Record<string, unknown>).validWhen).toBe('fullName != "Bob"');
    expect((fullName().configuration as Record<string, unknown>).messages).toEqual({ rule: "Anyone but Bob." });
    // The label and its translation are untouched.
    expect((fullName().configuration as Record<string, unknown>).label).toBe("Full name");
    expect(controller.translations()?.["fr-CA"]?.components?.fullName?.label).toMatchObject({ text: "Nom complet" });

    // Read back: the list's sentence, and the editor opened again holds the formula and the message.
    const card = (): HTMLButtonElement | null => logic(element).querySelector<HTMLButtonElement>('[data-logic-rule="form:fullName:validWhen"]');
    await until(() => card());
    logic(element).querySelector<HTMLButtonElement>("[data-logic-close], [data-logic-discard]")!.click();
    card()!.click();
    await until(() => box(element));
    expect(box(element).value).toBe('fullName != "Bob"');
    expect(logic(element).querySelector<HTMLInputElement>("[data-logic-message]")!.value).toBe("Anyone but Bob.");

    // One undo step took both.
    controller.undo();
    expect(fullName().rules).toBeUndefined();
    expect((fullName().configuration as Record<string, unknown>).messages).toBeUndefined();
  });

  it("edits a translated check message's text and keeps its translation", async () => {
    const element = await mountInLogic();
    const controller = element.builder!.controller;
    controller.setProperties([
      { componentId: "fullName", propertyPath: "validWhen", value: 'fullName != "Bob"', target: "rules" },
      { componentId: "fullName", propertyPath: "messages.rule", value: "Not Bob." }
    ]);
    // Its French is an entry of the form's translations map, at the message's own address.
    controller.setTranslations([{ locale: "fr-CA", address: addressOf.message("fullName", "rule"), text: "Pas Bob." }]);
    const card = (): HTMLButtonElement | null => logic(element).querySelector<HTMLButtonElement>('[data-logic-rule="form:fullName:validWhen"]');
    await until(() => card());
    card()!.click();
    await until(() => box(element));
    const message = logic(element).querySelector<HTMLInputElement>("[data-logic-message]")!;
    expect(message.value).toBe("Not Bob.");
    message.value = "Anyone but Bob.";
    fire(message, "input");
    expect(apply(element).disabled).toBe(false);
    apply(element).click();
    const configuration = nodeOf(element, "fullName").configuration as Record<string, unknown>;
    expect(configuration.messages).toEqual({ rule: "Anyone but Bob." });
    // The French stays in the map (flagged as answering the old wording, which Languages shows).
    expect(controller.translations()?.["fr-CA"]?.components?.fullName?.messages).toMatchObject({ rule: { text: "Pas Bob." } });
    // The rule's own text was not touched, so it was not rewritten.
    expect((nodeOf(element, "fullName").rules as Record<string, unknown>).validWhen).toBe('fullName != "Bob"');
  });

  it("Validate: a checkbox that holds false is unchecked in Try it, as the form judges it", async () => {
    const element = document.createElement("datum-form-builder");
    const definition = sampleDefinition();
    // A calculation hands the checkbox a false the author never typed (Try it's own box cannot).
    definition.root.children!.content!.push({
      id: "agree",
      type: "checkbox",
      configuration: { label: "Agree" },
      rules: { value: { kind: "literal", value: false } }
    });
    element.definition = definition;
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    element.builder!.setWorkspace("logic");
    await until(() => surface(element)?.querySelector("[data-logic-rule]"));
    surfaceElement(element)!.formulaEditorLoader = offline;
    await startNew(element, "validate", "agree");
    type(element, "agree");
    expect(logic(element).querySelector("[data-logic-try-result] span")!.textContent).toBe("Agree is empty, so it is not checked");
  });

  it("Validate: choosing a field that already has a rule message starts the box from it and Apply does not rewrite it", async () => {
    const element = await mountInLogic();
    element.builder!.controller.setProperties([{ componentId: "fullName", propertyPath: "messages.rule", value: "Not Bob." }]);
    element.builder!.controller.setTranslations([{ locale: "fr-CA", address: addressOf.message("fullName", "rule"), text: "Pas Bob." }]);
    await startNew(element, "validate", "fullName");
    const message = logic(element).querySelector<HTMLInputElement>("[data-logic-message]")!;
    expect(message.value).toBe("Not Bob.");
    type(element, 'fullName != "Bob"');
    const own = logic(element).querySelector<HTMLInputElement>('[data-logic-try="fullName"]')!;
    own.value = "Bob";
    fire(own, "input");
    expect(logic(element).querySelector("[data-logic-try-result] span")!.textContent).toBe("Full name is refused: Not Bob.");
    apply(element).click();
    const configuration = nodeOf(element, "fullName").configuration as Record<string, unknown>;
    expect(configuration.messages).toEqual({ rule: "Not Bob." });
  });

  it("Validate: words typed before a field is chosen survive the choice, and Apply saves them", async () => {
    const element = await mountInLogic();
    logic(element).querySelector<HTMLButtonElement>("[data-logic-new]")!.click();
    logic(element).querySelector<HTMLButtonElement>('[data-logic-new-kind="validate"]')!.click();
    const typed = logic(element).querySelector<HTMLInputElement>("[data-logic-message]")!;
    typed.value = "Must be Ada";
    fire(typed, "input");
    const select = logic(element).querySelector<HTMLSelectElement>("[data-logic-target]")!;
    select.value = "fullName";
    fire(select, "change");
    await until(() => box(element));
    expect(logic(element).querySelector<HTMLInputElement>("[data-logic-message]")!.value).toBe("Must be Ada");
    type(element, 'fullName = "Ada"');
    apply(element).click();
    const configuration = nodeOf(element, "fullName").configuration as Record<string, unknown>;
    expect(configuration.messages).toEqual({ rule: "Must be Ada" });
  });

  it("Validate: words seeded from one field do not stop a switch to a field that already has the rule", async () => {
    const element = await mountInLogic();
    element.builder!.controller.setProperties([
      { componentId: "fullName", propertyPath: "messages.rule", value: "Not Bob." },
      { componentId: "email", propertyPath: "validWhen", value: 'email != ""', target: "rules" }
    ]);
    await startNew(element, "validate", "fullName");
    expect(logic(element).querySelector<HTMLInputElement>("[data-logic-message]")!.value).toBe("Not Bob.");
    const select = logic(element).querySelector<HTMLSelectElement>("[data-logic-target]")!;
    select.value = "email";
    fire(select, "change");
    await until(() => box(element)?.value === 'email != ""');
    expect(box(element).value).toBe('email != ""');
  });

  it("Validate and Require offer no field inside a repeating section, Show still does", async () => {
    const element = document.createElement("datum-form-builder");
    const definition = sampleDefinition();
    definition.root.children!.content!.push({
      id: "items",
      type: "fieldset",
      configuration: { label: "Items" },
      collection: { itemFields: ["sku"], collectionPath: "items" },
      children: { content: [{ id: "sku", type: "text", configuration: { label: "SKU" } }] }
    });
    element.definition = definition;
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    element.builder!.setWorkspace("logic");
    await until(() => surface(element)?.querySelector("[data-logic-rule]"));
    const choices = (kind: string): string[] => {
      logic(element).querySelector<HTMLButtonElement>("[data-logic-new]")!.click();
      logic(element).querySelector<HTMLButtonElement>(`[data-logic-new-kind="${kind}"]`)!.click();
      return [...logic(element).querySelectorAll<HTMLOptionElement>("[data-logic-target] option")].map((option) => option.value);
    };
    expect(choices("validate")).toContain("fullName");
    expect(choices("validate")).not.toContain("sku");
    logic(element).querySelector<HTMLButtonElement>("[data-logic-discard], [data-logic-close]")?.click();
    expect(choices("require")).not.toContain("sku");
    logic(element).querySelector<HTMLButtonElement>("[data-logic-discard], [data-logic-close]")?.click();
    expect(choices("show")).toContain("sku");
  });

  it("tries the rule against answers typed beside it, through the preview runtime", async () => {
    const element = await mountInLogic();
    ruleCard(element).click();
    const result = (): string => logic(element).querySelector("[data-logic-try-result] span")!.textContent!;
    expect(result()).toBe("Email is hidden");
    const tick = logic(element).querySelector<HTMLInputElement>('[data-logic-try="subscribe"]')!;
    tick.checked = true;
    fire(tick, "change");
    expect(result()).toBe("Email is shown");
    // A keystroke that reads the same fields keeps the boxes (and the answer typed in them).
    type(element, "subscribe or subscribe");
    expect(logic(element).querySelector<HTMLInputElement>('[data-logic-try="subscribe"]')!.checked).toBe(true);
    expect(result()).toBe("Email is shown");
  });

  it("runs one preview runtime per keystroke, none when the Try it fields are unchanged and the text is the same, and never repaints", async () => {
    const element = await mountInLogic();
    ruleCard(element).click();
    const states = vi.spyOn(BuilderPreviewRuntime.prototype, "effectiveStatesMap");
    const host = logic(element).querySelector(".logic")!;
    try {
      states.mockClear();
      type(element, "subscribe or subscribe");
      expect(states).toHaveBeenCalledTimes(1);
      states.mockClear();
      type(element, "subscribe or not(subscribe)");
      expect(states).toHaveBeenCalledTimes(1);
      // A keystroke changing the fields read redraws the boxes and still runs once.
      states.mockClear();
      type(element, "subscribe or fullName = \"Ada\"");
      expect(states).toHaveBeenCalledTimes(1);
      expect(logic(element).querySelector(".logic")).toBe(host);
    } finally {
      states.mockRestore();
    }
  });

  it("prints the field on paper with the rule's words as its note, when On paper is ticked", async () => {
    const element = await mountInLogic();
    ruleCard(element).click();
    const paper = logic(element).querySelector<HTMLInputElement>("[data-logic-paper]")!;
    expect(paper.checked).toBe(false);
    paper.checked = true;
    fire(paper, "change");
    apply(element).click();
    const email = nodeOf(element, "email");
    expect((email.configuration as Record<string, unknown>).print).toEqual({ show: "always", note: "Complete only if Subscribe is ticked." });
    // Unticked again, the field prints as on screen; the note the author may have reworded stays.
    await until(() => logic(element).querySelector<HTMLInputElement>("[data-logic-paper]")?.checked === true);
    const again = logic(element).querySelector<HTMLInputElement>("[data-logic-paper]")!;
    again.checked = false;
    fire(again, "change");
    apply(element).click();
    const after = nodeOf(element, "email");
    expect((after.configuration as Record<string, unknown>).print).toEqual({ note: "Complete only if Subscribe is ticked." });
  });

  it("asks before another rule replaces a copy not applied", async () => {
    const element = await mountInLogic();
    const controller = element.builder!.controller;
    controller.setProperties([{ componentId: "country", propertyPath: "requiredWhen", value: "subscribe", target: "rules" }]);
    await until(() => logic(element).querySelector('[data-logic-rule="form:country:requiredWhen"]'));
    ruleCard(element).click();
    const clear = logic(element).querySelector<HTMLInputElement>('[data-logic-hidden][value="clear"]')!;
    clear.checked = true;
    fire(clear, "change");
    logic(element).querySelector<HTMLButtonElement>('[data-logic-rule="form:country:requiredWhen"]')!.click();
    expect(logic(element).querySelector("[data-unsaved-prompt]")).not.toBeNull();
    logic(element).querySelector<HTMLButtonElement>("[data-unsaved-save]")!.click();
    expect((nodeOf(element, "email").configuration as Record<string, unknown>).hiddenValueBehavior).toBe("clear");
    expect(logic(element).querySelector("[data-logic-editor] h2")!.textContent).toBe("Require a field");
    expect(box(element).value).toBe("subscribe");
  });

  it("keeps the plain box with a Retry when the editor's chunk fails, and swaps the editor in when it lands", async () => {
    const element = await mountInLogic(offline);
    ruleCard(element).click();
    expect(box(element)).not.toBeNull();
    await until(() => logic(element).querySelector("[data-logic-editor-failed]"));
    expect(logic(element).querySelector("[data-logic-editor-failed]")!.textContent).toContain("The formula editor could not load; the plain box still works.");
    // The box still works meanwhile.
    type(element, "not(subscribe)");
    expect(readsAs(element)).toBe("Show Email when Subscribe is not ticked");
    // Retry with the chunk reachable again: the editor takes the box's place, text kept.
    surfaceElement(element)!.formulaEditorLoader = realLoader!;
    logic(element).querySelector<HTMLButtonElement>("[data-logic-editor-retry]")!.click();
    await until(() => logic(element).querySelector(".formula-editor .cm-editor"));
    expect(logic(element).querySelector(".formula-textarea")).toBeNull();
    // The chip shows the field's label; the id is what the text holds.
    expect(logic(element).querySelector(".formula-editor .cm-content")!.textContent).toBe("not(Subscribe)");
    expect(logic(element).querySelector(".formula-editor .f-field")!.getAttribute("title")).toBe("subscribe");
  });

  it("draws every word from the builder text catalog in its locale, with Try it under a row label", async () => {
    const element = await mountInLogic();
    const logicEl = surfaceElement(element)! as LogicSurface & { locale: string | undefined; catalog: unknown };
    logicEl.catalog = {
      xx: {
        "logic.newRule": "Nouvelle règle",
        "logic.kind.show": "Afficher un champ",
        "logic.kind.show.hint": "Caché jusqu'à la condition.",
        "logic.kind.show.lead": "Afficher {field} lorsque",
        "logic.kind.hide": "Masquer un champ",
        "logic.editor.field": "Champ",
        "logic.editor.runs": "Exécution",
        "logic.editor.asFormula": "Écrire une formule",
        "logic.editor.formula": "Formule",
        "logic.editor.apply": "Appliquer",
        "logic.editor.close": "Fermer",
        "logic.editor.discard": "Abandonner",
        "logic.editor.notApplied": "Non appliqué",
        "logic.editor.remove": "Retirer la règle",
        "logic.editor.hiddenAnswer": "Une fois caché, la réponse est",
        "logic.editor.paper": "Sur papier",
        "logic.rules.count.one": "{count} règle",
        "logic.rules.count.other": "{count} règles",
        "try.title": "Essayer",
        "try.hidden": "{field} est caché",
        "try.shown": "{field} est affiché",
        "try.bothSides": "des deux côtés",
        "formula.err.expectedValue": "Valeur manquante."
      }
    };
    logicEl.locale = "xx";
    expect(logic(element).querySelector("[data-logic-new]")!.textContent).toBe("Nouvelle règle");
    expect(logic(element).querySelector('[data-logic-new-kind="hide"] strong')!.textContent).toBe("Masquer un champ");
    expect(logic(element).querySelector('[data-logic-filter="all"] .filter-count')!.getAttribute("aria-label")).toBe("1 règle");
    ruleCard(element).click();
    await until(() => box(element));
    expect(logic(element).querySelector("#editor-title")!.textContent).toBe("Afficher un champ");
    expect(logic(element).querySelector(".editor-head .card-lead")!.textContent).toBe("Caché jusqu'à la condition.");
    expect(logic(element).querySelector("#logic-formula-lead")!.textContent).toBe("Afficher Email lorsque");
    expect([...logic(element).querySelectorAll(".head-row .field-label")].map((label) => label.textContent)).toEqual(["Champ", "Exécution"]);
    expect(logic(element).querySelector(".formula-lead .card-lead")!.textContent).toBe("Écrire une formule");
    expect(box(element).getAttribute("aria-label")).toBe("Formule");
    expect(logic(element).querySelector(".hidden-choice legend")!.textContent).toBe("Une fois caché, la réponse est");
    expect(logic(element).querySelector(".paper-choice")!.textContent).toContain("Sur papier");
    expect(logic(element).querySelector("[data-logic-remove]")!.textContent).toBe("Retirer la règle");
    expect(logic(element).querySelector("[data-logic-dirty]")!.textContent).toBe("Non appliqué");
    expect(logic(element).querySelector("[data-logic-discard]")!.textContent).toBe("Fermer");
    expect(apply(element).textContent).toBe("Appliquer");
    // Try it: a row label (the h3) above the sunken box, never a legend over its border.
    const tryBox = logic(element).querySelector<HTMLElement>(".try")!;
    expect(tryBox.tagName).toBe("DIV");
    expect(tryBox.querySelector("legend")).toBeNull();
    const title = logic(element).querySelector<HTMLElement>("#logic-try-title")!;
    expect(title.textContent).toBe("Essayer");
    expect(title.nextElementSibling).toBe(tryBox);
    expect(tryBox.getAttribute("aria-labelledby")).toBe("logic-try-title");
    expect(logic(element).querySelector("[data-logic-try-result] span")!.textContent).toBe("Email est caché");
    expect(logic(element).querySelector("[data-logic-try-result] .side")!.textContent).toBe("des deux côtés");
    // The live parts after a keystroke read from the same catalog.
    type(element, "subscribe or");
    expect(logic(element).querySelector("[data-logic-discard]")!.textContent).toBe("Abandonner");
    expect(problemLine(element).textContent).toContain("Valeur manquante.");
  });

  it("mounts the CodeMirror editor by default and keeps it across a repaint", async () => {
    const element = await mountInLogic(null);
    ruleCard(element).click();
    await until(() => logic(element).querySelector(".formula-editor .cm-editor"));
    const editor = logic(element).querySelector(".formula-editor .cm-editor");
    // A change elsewhere repaints the surface; the same editor DOM is moved, not rebuilt.
    element.builder!.controller.setProperties([{ componentId: "country", propertyPath: "label", value: "Nation" }]);
    await until(() => logic(element).querySelector('[data-logic-editor]'));
    expect(logic(element).querySelector(".formula-editor .cm-editor")).toBe(editor);
  });
});

describe("the Logic filters at the narrow tiers", () => {
  it("wraps the kind chips and gives New rule the row under them, so no chip hides behind the button", async () => {
    const element = await mountInLogic();
    const css = [...logic(element).querySelectorAll("style")].map((style) => style.textContent).join("\n");
    expect(css).toMatch(/:host\(\[data-phone\]\) \.filter-list \{ flex-wrap: wrap; overflow-x: visible; \}/);
    expect(css).toMatch(/:host\(\[data-phone\]\) \.logic-filters \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    expect(css).toMatch(/@container \(max-width: 599px\) \{[^@]*\.filter-list \{ flex-wrap: wrap/);
    // Every kind chip and New rule are in the markup.
    expect(logic(element).querySelectorAll("[data-logic-filter]").length).toBe(7);
    expect(logic(element).querySelector("[data-logic-new]")).not.toBeNull();
    // The rule drawer's Close shows wherever the drawer overlays the list.
    expect(css).toMatch(/@container \(max-width: 899px\) \{ \.sheet-close-btn \{ display: inline-flex; \} \}/);
  });

  it("marks the workspace while a strip drawer is open, and the CSS pads the surface by the drawer's width", async () => {
    const element = await mountInLogic();
    const builder = element.builder!;
    const wrap = shell(element).querySelector<HTMLElement>('[data-shell="wrap"]')!;
    builder.panel = undefined;
    expect(wrap.hasAttribute("data-drawer-open")).toBe(false);
    builder.panel = "outline";
    expect(wrap.hasAttribute("data-drawer-open")).toBe(true);
    builder.panel = undefined;
    expect(wrap.hasAttribute("data-drawer-open")).toBe(false);
    const css = [...shell(element).querySelectorAll("style")].map((style) => style.textContent).join("\n");
    expect(css).toMatch(/\.wrap\[data-drawer-open\]:not\(\[data-narrow\]\):is\(\[data-workspace="logic"\], \[data-workspace="data"\], \[data-workspace="languages"\], \[data-workspace="print"\]\) \.logic-host \{\s*margin-left: calc\(2 \* var\(--db-gap\) \+ min\(var\(--db-side-w\)/);
  });
});


/**
 * A journey's Go to rules in the Logic editor: listed with the form's
 * rules, edited in the same layout, written to the journey's own controller as one undo step each
 * (the form's controller is never written), the target list the path accepts.
 */
describe("Go to rules in the Logic workspace", () => {
  const subscribed: Expression = { kind: "path", path: "subscribe" };

  function journeyDefinition(): FormDefinition {
    return {
      ...sampleDefinition(),
      journey: {
        journeys: [
          {
            id: "flow",
            name: "Flow",
            pages: [
              { id: "start", title: "Start", components: ["fullName", "subscribe"], routes: [{ when: subscribed, to: "news" }, { to: "plain" }] },
              { id: "plain", title: "Plain", components: ["country"] },
              { id: "news", title: "News", components: ["email"] }
            ]
          }
        ]
      }
    };
  }

  async function mountJourneyLogic(): Promise<DatumFormBuilderElement> {
    const element = document.createElement("datum-form-builder");
    element.setAttribute("pdf", "off");
    element.definition = journeyDefinition();
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    element.builder!.setWorkspace("logic");
    await until(() => surface(element)?.querySelector('[data-logic-rule^="journeys:"]'));
    surfaceElement(element)!.formulaEditorLoader = offline;
    // The rules are editable once the Journeys mode's designer is in.
    await until(() => !logic(element).querySelector('[data-logic-rule^="journeys:"].rule--readonly'));
    return element;
  }

  const routeCard = (element: DatumFormBuilderElement, index: number): HTMLButtonElement =>
    logic(element).querySelector<HTMLButtonElement>(`[data-logic-rule="journeys:flow:start:route:${index}"]`)!;
  const journey = (element: DatumFormBuilderElement) => element.journeyMode!.journey!;
  const startRoutes = (element: DatumFormBuilderElement) => journey(element).pages[0]!.routes!;
  const routesJson = (element: DatumFormBuilderElement): string => JSON.stringify(startRoutes(element));
  const toSelect = (element: DatumFormBuilderElement): HTMLSelectElement => logic(element).querySelector<HTMLSelectElement>("[data-logic-to]")!;
  const optionValues = (select: HTMLSelectElement): string[] => [...select.options].map((option) => option.value);
  const words = (node: Element | null): string => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  /** Undoes once on the journey's controller; the history holds nothing more when a second undo leaves the journey as the first did. */
  function undoOnce(element: DatumFormBuilderElement): { afterFirst: string; afterSecond: string } {
    element.journeyMode!.controller.undo();
    const afterFirst = JSON.stringify(journey(element));
    element.journeyMode!.controller.undo();
    return { afterFirst, afterSecond: JSON.stringify(journey(element)) };
  }

  it("lists a journey's rules with the form's, one with no condition too, each opening in this editor instead of the designer", async () => {
    const element = await mountJourneyLogic();
    expect([0, 1].map((index) => words(routeCard(element, index)))).toEqual(["Go to News when Subscribe is ticked", "Go to Plain always"]);
    expect(logic(element).querySelector("[data-logic-open-doc]")).toBeNull();
    expect(logic(element).querySelector('[data-logic-filter="journeys"] .filter-count')!.textContent).toBe("2");
    expect(routeCard(element, 0).classList.contains("rule--readonly")).toBe(false);
    // A form rule is still listed with them, and the count is the two kinds together.
    expect(ruleCard(element)).not.toBeNull();
    expect(logic(element).querySelector('[data-logic-filter="all"] .filter-count')!.textContent).toBe("3");
  });

  it("opens a Go to rule with From fixed, Go to, its place in the order, the condition and Reads as, and selects its route on the journey", async () => {
    const element = await mountJourneyLogic();
    routeCard(element, 0).click();
    const editor = logic(element).querySelector("[data-logic-editor]")!;
    expect(editor.getAttribute("data-logic-kind")).toBe("route");
    expect(editor.querySelector("h2")!.textContent).toBe("Go to a step");
    expect(words(editor.querySelector("[data-logic-from-fixed]"))).toBe("Start");
    expect(toSelect(element).value).toBe("news");
    expect(words(editor.querySelector("[data-logic-order]"))).toContain("Tried 1st of 2 from this step");
    expect(editor.querySelector<HTMLButtonElement>('[data-logic-move="-1"]')!.disabled).toBe(true);
    expect(editor.querySelector<HTMLButtonElement>('[data-logic-move="1"]')!.disabled).toBe(false);
    expect(editor.querySelector("#logic-formula-lead")!.textContent).toBe("Go to News when");
    expect(box(element).value).toBe("subscribe");
    expect(readsAs(element)).toBe("Go to News when Subscribe is ticked");
    expect(editor.querySelector("[data-logic-run-btn]")).toBeNull();
    // Try it: the answers the condition reads, and what the rule makes of them.
    const tick = logic(element).querySelector<HTMLInputElement>('input[data-logic-try="subscribe"]')!;
    tick.checked = true;
    fire(tick, "change");
    expect(logic(element).querySelector("[data-logic-try-result]")!.textContent).toContain("Goes to News");
    tick.checked = false;
    fire(tick, "change");
    expect(logic(element).querySelector("[data-logic-try-result]")!.textContent).toContain("Not taken");
    // The map follows: the journey's selection is the route.
    const routeNode = element.journeyMode!.controller.snapshot().children!.pages![0]!.children!.routes![0]!.id;
    expect(element.journeyMode!.controller.selectedComponentId()).toBe(routeNode);
    // The second rule has no condition: its box is empty and the note says what that means.
    routeCard(element, 1).click();
    expect(box(element).value).toBe("");
    expect(words(logic(element).querySelector("[data-logic-order]"))).toContain("Tried 2nd of 2 from this step");
    expect(readsAs(element)).toBe("Go to Plain always");
  });

  it("applies a changed condition as one undo step on the journey, and never writes the form", async () => {
    const element = await mountJourneyLogic();
    const form = element.builder!.controller;
    const formBefore = JSON.stringify(form.snapshot());
    const before = routesJson(element);
    routeCard(element, 0).click();
    type(element, "not(subscribe)");
    expect(apply(element).disabled).toBe(false);
    apply(element).click();
    expect(startRoutes(element)[0]).toEqual({ when: "not(subscribe)", to: "news" });
    expect(JSON.stringify(form.snapshot())).toBe(formBefore);
    expect(words(routeCard(element, 0))).toBe("Go to News when Subscribe is not ticked");
    const undone = undoOnce(element);
    expect(JSON.stringify(startRoutes(element))).toBe(before);
    expect(undone.afterSecond).toBe(undone.afterFirst);
  });

  it("applies a changed target as one undo step, and a target and condition together in one", async () => {
    const element = await mountJourneyLogic();
    const before = routesJson(element);
    routeCard(element, 0).click();
    toSelect(element).value = "$end";
    fire(toSelect(element), "change");
    expect(apply(element).disabled).toBe(false);
    expect(logic(element).querySelector("#logic-formula-lead")!.textContent).toBe("Go to the end when");
    apply(element).click();
    expect(startRoutes(element)[0]).toMatchObject({ to: "$end" });
    expect(words(routeCard(element, 0))).toBe("Go to the end when Subscribe is ticked");
    let undone = undoOnce(element);
    expect(JSON.stringify(startRoutes(element))).toBe(before);
    expect(undone.afterSecond).toBe(undone.afterFirst);
    // Both at once: one step, not two.
    routeCard(element, 0).click();
    toSelect(element).value = "plain";
    fire(toSelect(element), "change");
    type(element, "country = \"CA\"");
    apply(element).click();
    expect(startRoutes(element)[0]).toEqual({ when: 'country = "CA"', to: "plain" });
    undone = undoOnce(element);
    expect(JSON.stringify(startRoutes(element))).toBe(before);
    expect(undone.afterSecond).toBe(undone.afterFirst);
  });

  it("moves a rule in the order its step tries them in, one undo step each, and the editor follows the rule", async () => {
    const element = await mountJourneyLogic();
    const before = routesJson(element);
    routeCard(element, 0).click();
    logic(element).querySelector<HTMLButtonElement>('[data-logic-move="1"]')!.click();
    expect(startRoutes(element).map((route) => route.to)).toEqual(["plain", "news"]);
    // The same rule, now second: its text is still the one in the box and the buttons say where it can go.
    expect(box(element).value).toBe("subscribe");
    expect(words(logic(element).querySelector("[data-logic-order]"))).toContain("Tried 2nd of 2 from this step");
    expect(logic(element).querySelector<HTMLButtonElement>('[data-logic-move="1"]')!.disabled).toBe(true);
    expect(logic(element).querySelector<HTMLButtonElement>('[data-logic-move="-1"]')!.disabled).toBe(false);
    expect(logic(element).querySelector(`[data-logic-rule="journeys:flow:start:route:1"]`)!.getAttribute("aria-pressed")).toBe("true");
    const undone = undoOnce(element);
    expect(JSON.stringify(startRoutes(element))).toBe(before);
    expect(undone.afterSecond).toBe(undone.afterFirst);
  });

  it("offers a target the path accepts: the steps after the one it leaves, in order, then the end, never an earlier step or itself", async () => {
    const element = await mountJourneyLogic();
    routeCard(element, 0).click();
    expect(optionValues(toSelect(element))).toEqual(["", "plain", "news", "$end"]);
    // A new rule from a later step: only what follows it.
    logic(element).querySelector<HTMLButtonElement>("[data-logic-new]")!.click();
    logic(element).querySelector<HTMLButtonElement>('[data-logic-new-kind="route"]')!.click();
    const fromSelect = (): HTMLSelectElement => logic(element).querySelector<HTMLSelectElement>("[data-logic-from]")!;
    expect(optionValues(fromSelect())).toEqual(["", "flow/start", "flow/plain", "flow/news"]);
    expect(optionValues(toSelect(element))).toEqual([""]);
    // The surface draws afresh on each choice, so the select is found again.
    fromSelect().value = "flow/plain";
    fire(fromSelect(), "change");
    expect(optionValues(toSelect(element))).toEqual(["", "news", "$end"]);
    fromSelect().value = "flow/news";
    fire(fromSelect(), "change");
    expect(optionValues(toSelect(element))).toEqual(["", "$end"]);
    // The next step in order is chosen for the author; the last step goes to the end.
    expect(toSelect(element).value).toBe("$end");
  });

  it("offers New rule's Go to a step only where a journey has a step to leave", async () => {
    const plain = await mountInLogic();
    expect(logic(plain).querySelector('[data-logic-new-kind="route"]')).toBeNull();
    const element = await mountJourneyLogic();
    expect(logic(element).querySelector('[data-logic-new-kind="route"] strong')!.textContent).toBe("Go to a step");
  });

  it("creates a rule from a step before the step's first rule with no condition, so it can be tried, as one undo step", async () => {
    const element = await mountJourneyLogic();
    const before = routesJson(element);
    logic(element).querySelector<HTMLButtonElement>("[data-logic-new]")!.click();
    logic(element).querySelector<HTMLButtonElement>('[data-logic-new-kind="route"]')!.click();
    const from = logic(element).querySelector<HTMLSelectElement>("[data-logic-from]")!;
    // Nothing is chosen yet: Apply says what is missing.
    expect(problemLine(element).textContent).toContain("Choose the step this rule leaves");
    from.value = "flow/start";
    fire(from, "change");
    expect(toSelect(element).value).toBe("plain");
    await until(() => box(element));
    type(element, "not(subscribe)");
    apply(element).click();
    expect(startRoutes(element)).toEqual([{ when: subscribed, to: "news" }, { when: "not(subscribe)", to: "plain" }, { to: "plain" }]);
    // Saved: the editor is the rule's own now, third of three... second of three.
    expect(words(logic(element).querySelector("[data-logic-from-fixed]"))).toBe("Start");
    expect(words(logic(element).querySelector("[data-logic-order]"))).toContain("Tried 2nd of 3 from this step");
    const undone = undoOnce(element);
    expect(JSON.stringify(startRoutes(element))).toBe(before);
    expect(undone.afterSecond).toBe(undone.afterFirst);
  });

  it("appends a new rule when the step has none with no condition, and one with no condition is allowed", async () => {
    const element = await mountJourneyLogic();
    // Take the unconditional rule away; then a new rule goes last.
    routeCard(element, 1).click();
    logic(element).querySelector<HTMLButtonElement>("[data-logic-remove]")!.click();
    expect(startRoutes(element).map((route) => route.to)).toEqual(["news"]);
    logic(element).querySelector<HTMLButtonElement>("[data-logic-new]")!.click();
    logic(element).querySelector<HTMLButtonElement>('[data-logic-new-kind="route"]')!.click();
    const from = logic(element).querySelector<HTMLSelectElement>("[data-logic-from]")!;
    from.value = "flow/start";
    fire(from, "change");
    toSelect(element).value = "$end";
    fire(toSelect(element), "change");
    apply(element).click();
    expect(startRoutes(element).map((route) => [route.to, route.when === undefined ? "always" : "when"])).toEqual([["news", "when"], ["$end", "always"]]);
  });

  it("removes a rule as one undo step, and says so", async () => {
    const element = await mountJourneyLogic();
    const before = routesJson(element);
    routeCard(element, 0).click();
    logic(element).querySelector<HTMLButtonElement>("[data-logic-remove]")!.click();
    expect(startRoutes(element)).toEqual([{ to: "plain" }]);
    expect(logic(element).querySelector("[data-logic-editor]")).toBeNull();
    expect(logic(element).querySelectorAll('[data-logic-rule^="journeys:"]').length).toBe(1);
    const undone = undoOnce(element);
    expect(JSON.stringify(startRoutes(element))).toBe(before);
    expect(undone.afterSecond).toBe(undone.afterFirst);
  });

  it("holds Apply back for a condition that does not parse, and for a rule with nowhere to go", async () => {
    const element = await mountJourneyLogic();
    routeCard(element, 0).click();
    type(element, "subscribe and");
    expect(problemLine(element).hidden).toBe(false);
    expect(problemLine(element).dataset.severity).toBe("error");
    const before = routesJson(element);
    apply(element).click();
    expect(routesJson(element)).toBe(before);
    toSelect(element).value = "";
    fire(toSelect(element), "change");
    type(element, "subscribe");
    expect(problemLine(element).textContent).toContain("Choose where this rule goes");
  });

  /** The journey of the first describe with other routes on its first step, and extra steps after the others. */
  async function mountWith(routes: unknown[], extra: unknown[] = [], attributes: Record<string, string> = {}): Promise<DatumFormBuilderElement> {
    const element = document.createElement("datum-form-builder");
    element.setAttribute("pdf", "off");
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, value);
    }
    element.definition = {
      ...sampleDefinition(),
      journey: {
        journeys: [
          {
            id: "flow",
            name: "Flow",
            pages: [
              { id: "start", title: "Start", components: ["fullName", "subscribe"], routes },
              { id: "plain", title: "Plain", components: ["country"] },
              { id: "news", title: "News", components: ["email"] },
              ...extra
            ]
          }
        ]
      }
    } as FormDefinition;
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    element.builder!.setWorkspace("logic");
    await until(() => surface(element)?.querySelector('[data-logic-rule^="journeys:"]'));
    surfaceElement(element)!.formulaEditorLoader = offline;
    return element;
  }

  it("undoes a Go to edit from the bar's own Undo, and leaves the form's last edit alone", async () => {
    const element = await mountJourneyLogic();
    const form = element.builder!.controller;
    form.setProperties([{ componentId: "fullName", propertyPath: "label", value: "Name X" }]);
    const label = (): unknown => (form.snapshot().children!.content!.find((node) => node.id === "fullName")!.configuration as Record<string, unknown>).label;
    const before = routesJson(element);
    routeCard(element, 0).click();
    type(element, "not(subscribe)");
    apply(element).click();
    expect(startRoutes(element)[0]).toEqual({ when: "not(subscribe)", to: "news" });
    // While Logic is on the page the bar's Undo is the form's: it takes the rule back first, not the label.
    element.builder!.undo();
    expect(JSON.stringify(startRoutes(element))).toBe(before);
    expect(label()).toBe("Name X");
    expect(words(routeCard(element, 0))).toBe("Go to News when Subscribe is ticked");
    // Redo puts it again; then the next Undo takes the label, as it should.
    element.builder!.redo();
    expect(startRoutes(element)[0]).toEqual({ when: "not(subscribe)", to: "news" });
    element.builder!.undo();
    element.builder!.undo();
    expect(label()).not.toBe("Name X");
    expect(JSON.stringify(startRoutes(element))).toBe(before);
  });

  it("undoes a created, a moved and a removed rule from the bar's Undo too", async () => {
    const element = await mountJourneyLogic();
    const before = routesJson(element);
    routeCard(element, 0).click();
    logic(element).querySelector<HTMLButtonElement>('[data-logic-move="1"]')!.click();
    expect(startRoutes(element).map((route) => route.to)).toEqual(["plain", "news"]);
    element.builder!.undo();
    expect(JSON.stringify(startRoutes(element))).toBe(before);
    routeCard(element, 0).click();
    logic(element).querySelector<HTMLButtonElement>("[data-logic-remove]")!.click();
    expect(startRoutes(element)).toEqual([{ to: "plain" }]);
    element.builder!.undo();
    expect(JSON.stringify(startRoutes(element))).toBe(before);
    logic(element).querySelector<HTMLButtonElement>("[data-logic-new]")!.click();
    logic(element).querySelector<HTMLButtonElement>('[data-logic-new-kind="route"]')!.click();
    const from = logic(element).querySelector<HTMLSelectElement>("[data-logic-from]")!;
    from.value = "flow/start";
    fire(from, "change");
    apply(element).click();
    expect(startRoutes(element)).toHaveLength(3);
    element.builder!.undo();
    expect(JSON.stringify(startRoutes(element))).toBe(before);
  });

  it("takes up the journeys when the Journeys mode arrives after the surface looked", async () => {
    const element = await mountWith([{ when: subscribed, to: "news" }, { to: "plain" }], [], { features: "-journeys" });
    // No mode yet: the rules are listed as the definition has them, read-only, and New rule has no Go to a step.
    expect(element.journeyMode).toBeUndefined();
    expect(routeCard(element, 0).classList.contains("rule--readonly")).toBe(true);
    element.removeAttribute("features");
    await until(() => element.journeyMode !== undefined && !logic(element).querySelector('[data-logic-rule^="journeys:"].rule--readonly'));
    logic(element).querySelector<HTMLButtonElement>("[data-logic-new]")!.click();
    expect(logic(element).querySelector('[data-logic-new-kind="route"]')).not.toBeNull();
    // And editable: a click opens the editor, which writes.
    logic(element).querySelector<HTMLButtonElement>("[data-logic-new]")!.click();
    routeCard(element, 0).click();
    type(element, "not(subscribe)");
    apply(element).click();
    expect(startRoutes(element)[0]).toEqual({ when: "not(subscribe)", to: "news" });
  });

  it("offers no step to leave from a review step or an exit step: the path takes no rule from either", async () => {
    const element = await mountWith([{ to: "plain" }], [{ id: "check", kind: "review" }, { id: "bye", kind: "exit", title: "Bye" }, { id: "after", title: "After", components: ["phone"] }]);
    await until(() => !logic(element).querySelector('[data-logic-rule^="journeys:"].rule--readonly'));
    logic(element).querySelector<HTMLButtonElement>("[data-logic-new]")!.click();
    logic(element).querySelector<HTMLButtonElement>('[data-logic-new-kind="route"]')!.click();
    const options = optionValues(logic(element).querySelector<HTMLSelectElement>("[data-logic-from]")!);
    expect(options).toContain("flow/start");
    expect(options).toContain("flow/after");
    expect(options).not.toContain("flow/check");
    expect(options).not.toContain("flow/bye");
  });

  it("says in a rule's editor when a rule before it with no condition means it is never tried", async () => {
    const element = await mountWith([{ to: "plain" }, { when: subscribed, to: "news" }]);
    await until(() => !logic(element).querySelector('[data-logic-rule^="journeys:"].rule--readonly'));
    // The rule with no condition names its own note, as before; the one it shadows does not carry it.
    routeCard(element, 0).click();
    expect(logic(element).querySelector(".order-note")!.textContent).toContain("always wins");
    expect(logic(element).querySelector("[data-logic-shadowed]")).toBeNull();
    routeCard(element, 1).click();
    expect(logic(element).querySelector("[data-logic-shadowed]")!.textContent).toContain("never tried");
    // Moved above the rule with no condition, it is tried, and the note goes.
    logic(element).querySelector<HTMLButtonElement>('[data-logic-move="-1"]')!.click();
    expect(logic(element).querySelector("[data-logic-shadowed]")).toBeNull();
  });

  it("tries a condition over what the path has: an answer asked on a later step is not read, and the editor says so", async () => {
    // "plain" asks country, a step after the one the rule leaves.
    const element = await mountWith([{ when: { kind: "binary", operator: "eq", left: { kind: "path", path: "country" }, right: { kind: "literal", value: "CA" } }, to: "news" }]);
    await until(() => !logic(element).querySelector('[data-logic-rule^="journeys:"].rule--readonly'));
    routeCard(element, 0).click();
    const country = logic(element).querySelector<HTMLSelectElement | HTMLInputElement>('[data-logic-try="country"]')!;
    country.value = "CA";
    fire(country, "change");
    const result = logic(element).querySelector("[data-logic-try-result]")!.textContent!;
    expect(result).toContain("Not taken");
    expect(logic(element).querySelector("[data-logic-try-later]")!.textContent).toContain("Country");
    // An answer asked on this step is read.
    const own = await mountWith([{ when: subscribed, to: "news" }]);
    await until(() => !logic(own).querySelector('[data-logic-rule^="journeys:"].rule--readonly'));
    routeCard(own, 0).click();
    const tick = logic(own).querySelector<HTMLInputElement>('input[data-logic-try="subscribe"]')!;
    tick.checked = true;
    fire(tick, "change");
    expect(logic(own).querySelector("[data-logic-try-result]")!.textContent).toContain("Goes to News");
    expect(logic(own).querySelector("[data-logic-try-later]")).toBeNull();
  });

  it("keeps the editor and says so when a rule could not be removed, instead of announcing a removal", async () => {
    const element = await mountJourneyLogic();
    const before = routesJson(element);
    routeCard(element, 0).click();
    // The journey's controller refuses the removal.
    const refuse = vi.spyOn(element.journeyMode!.controller, "remove").mockImplementation(() => {
      throw new Error("refused");
    });
    logic(element).querySelector<HTMLButtonElement>("[data-logic-remove]")!.click();
    expect(refuse).toHaveBeenCalled();
    expect(routesJson(element)).toBe(before);
    expect(logic(element).querySelector("[data-logic-editor]")).not.toBeNull();
    expect(problemLine(element).hidden).toBe(false);
    expect(problemLine(element).textContent).toContain("could not be changed");
    expect(logic(element).querySelector("[data-logic-live]")?.textContent ?? "").not.toContain("Rule removed");
    refuse.mockRestore();
  });

  it("lists the rules read-only, with the button to the designer, for a surface the Journeys mode has no host for", async () => {
    const element = await mountJourneyLogic();
    // A surface over another controller: no mode registered a host under it, so it lists the definition's journeys as it always did.
    const bare = document.createElement("datum-builder-logic") as HTMLElement & { controller: unknown; definition: unknown };
    bare.controller = new BuilderController({ componentTypes: [], initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [] } } });
    bare.definition = () => journeyDefinition();
    document.body.append(bare);
    const root = bare.shadowRoot!;
    await until(() => root.querySelector('[data-logic-rule^="journeys:"]'));
    expect(root.querySelector('[data-logic-rule^="journeys:"]')!.classList.contains("rule--readonly")).toBe(true);
    expect(root.querySelector("[data-logic-open-doc]")).not.toBeNull();
    expect(root.querySelector('[data-logic-new-kind="route"]')).toBeNull();
    expect(element.isConnected).toBe(true);
  });
});
