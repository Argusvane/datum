import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/form.js";
import type { DatumFormElement } from "../src/form.js";

import { createFormRuntime } from "../src/runtime-factory.js";
import { formDefinitionProblem, toFormDefinition } from "../src/support.js";
import { sampleDefinition, until } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function typoDefinition() {
  const definition = sampleDefinition();
  const email = definition.root.children!.content!.find((c) => c.id === "email")!;
  email.rules = { visibleWhen: "subscribe +" } as never;
  return definition;
}

function mount(policy: string, definition: unknown): DatumFormElement {
  const element = document.createElement("datum-form");
  element.setAttribute("formula-errors", policy);
  element.definition = definition as never;
  document.body.append(element);
  return element;
}

const notice = (el: DatumFormElement) => el.shadowRoot!.querySelector<HTMLElement>("[data-form-error]");

describe("<datum-form> refused definition", () => {
  it("draws the failure under fail, keeps datum-error, and clears it on a good definition", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const element = document.createElement("datum-form");
    const errors: unknown[] = [];
    element.addEventListener("datum-error", (e) => errors.push((e as CustomEvent).detail));
    element.setAttribute("formula-errors", "fail");
    element.definition = typoDefinition() as never;
    document.body.append(element);
    await until(() => notice(element));
    const box = notice(element)!;
    expect(box.getAttribute("role")).toBe("alert");
    expect(box.textContent).toContain("formula problem");
    expect(box.querySelectorAll("li").length).toBeGreaterThan(0);
    expect(box.querySelector("li code")!.textContent).toContain("visibleWhen");
    expect(errors.length).toBeGreaterThan(0);
    expect((errors[0] as { code: string }).code).toBe("definition.build-failed");
    element.definition = sampleDefinition();
    await until(() => !notice(element) && element.renderer?.shadowRoot?.querySelector("form"));
    expect(notice(element)).toBeNull();
  });

  // fail is the default, warn the explicit opt-in.
  it("draws the failure by default, when neither the host nor the form names a policy", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const element = document.createElement("datum-form");
    element.definition = typoDefinition() as never;
    document.body.append(element);
    await until(() => notice(element));
    expect(notice(element)!.textContent).toContain("formula problem");
  });

  it("draws nothing under warn", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const element = mount("warn", typoDefinition());
    await until(() => element.renderer?.shadowRoot?.querySelector("form"));
    expect(notice(element)).toBeNull();
  });

  // A literal matches pattern that repeats a repeat is refused unless risky-patterns allows it.
  it("refuses a risky matches pattern by default and opens the form when risky-patterns is allow", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const risky = () => {
      const definition = sampleDefinition();
      const email = definition.root.children!.content!.find((c) => c.id === "email")!;
      email.rules = { visibleWhen: 'matches(name, "(a+)+$")' } as never;
      return definition;
    };
    const refused = document.createElement("datum-form");
    refused.definition = risky() as never;
    document.body.append(refused);
    await until(() => notice(refused));
    expect(notice(refused)!.textContent).toContain("formula problem");
    const allowed = document.createElement("datum-form");
    allowed.setAttribute("risky-patterns", "allow");
    expect(allowed.riskyPatterns).toBe("allow");
    allowed.definition = risky() as never;
    document.body.append(allowed);
    await until(() => allowed.renderer?.shadowRoot?.querySelector("form"));
    expect(notice(allowed)).toBeNull();
  });

  it("declares distinct error fallback colours in both schemes", () => {
    const src = readFileSync(resolve(process.cwd(), "src/form-element.ts"), "utf8");
    expect(src).toMatch(/\[data-form-error\] \{ --notice-fg: #b3261e; --notice-bg: #fdecea;/);
    expect(src).toMatch(/prefers-color-scheme: dark\) \{ \[data-form-error\] \{ --notice-fg: #ffb4ab;/);
    expect(src).toContain("color: var(--color-error, var(--notice-fg))");
  });
});

describe("<datum-form> definitions that repeat an id or loop", () => {
  it("says so, as a notice and a datum-error, when two components share an id", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const definition = {
      id: "dup", version: "1", schemaVersion: "1",
      root: { id: "root", type: "form", configuration: {}, children: { content: [
        { id: "x", type: "text", configuration: { label: "first" } },
        { id: "x", type: "text", configuration: { label: "second" } }
      ] } }
    };
    const element = document.createElement("datum-form");
    const errors: string[] = [];
    const codes: string[] = [];
    element.addEventListener("datum-error", (e) => {
      errors.push((e as CustomEvent).detail.message);
      codes.push((e as CustomEvent).detail.code);
    });
    element.definition = definition as never;
    document.body.append(element);
    await until(() => notice(element));
    expect(codes).toContain("definition.duplicate-ids");
    expect(notice(element)!.textContent).toContain('"x"');
    expect(errors.some((message) => message.includes('"x"'))).toBe(true);
    // The form is still drawn; the notice is a report, not a refusal.
    await until(() => element.renderer?.shadowRoot?.querySelector("form"));
    element.definition = sampleDefinition();
    await until(() => !notice(element));
  });

  it("a definition with a component that is its own ancestor is refused with a message", () => {
    const root: any = { id: "root", type: "form", configuration: {}, children: { content: [] } };
    const section: any = { id: "s", type: "container", configuration: {}, children: { content: [] } };
    section.children.content.push({ id: "t", type: "text", configuration: { label: "t" } }, root);
    root.children.content.push(section);
    const definition = { id: "cyc", version: "1", schemaVersion: "1", root };
    expect(() => createFormRuntime(definition as never, {})).toThrow(/cycle at component "root"/);
    expect(formDefinitionProblem(toFormDefinition(definition))).toMatch(/cycle at component "root"/);
  });
});
