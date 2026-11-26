/**
 * `<datum-form>`'s `hostContext` (and the `host-context` JSON attribute): what the form's `host.`
 * paths read. It drives the rules from the first paint, a change works the form out again in
 * place (the runtime is not rebuilt and the answers typed so far stay), it never travels in the
 * submission, and a value JSON cannot carry is left out and reported as `host-context.invalid`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FormDefinition } from "@argusvane/datum-engine";

import "../src/form.js";
import type { DatumFormElement, DatumFormSubmitDetail } from "../src/form.js";
import type { DatumErrorDetail } from "../src/support.js";
import { plainHostContext } from "../src/host-context.js";

import { paintedForm, until } from "./helpers.js";
import { control, type } from "./live-dom.js";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function definition(): FormDefinition {
  return {
    id: "host-form",
    version: "1.0.0",
    schemaVersion: "1",
    root: {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "name", type: "text", configuration: { label: "Name" } },
          { id: "admin_note", type: "text", configuration: { label: "Admin note", required: true }, rules: { visibleWhen: 'host.role = "admin"' } },
          { id: "region", type: "text", configuration: { label: "Region" }, rules: { value: 'coalesce(host.region, "none")' } }
        ]
      }
    }
  } as unknown as FormDefinition;
}

const shown = (root: ShadowRoot, id: string): boolean => root.querySelector(`[data-component-id="${id}"]`) !== null;

function errors(element: HTMLElement): DatumErrorDetail[] {
  const seen: DatumErrorDetail[] = [];
  element.addEventListener("datum-error", (event) => seen.push((event as CustomEvent<DatumErrorDetail>).detail));
  return seen;
}

describe("<datum-form> hostContext", () => {
  it("drives a host. visibility rule from the first paint", async () => {
    const element = document.createElement("datum-form") as DatumFormElement;
    element.hostContext = { role: "admin" };
    element.definition = definition();
    document.body.append(element);
    const root = await paintedForm(element);
    await until(() => shown(root, "admin_note"));
    expect(element.runtime?.effectiveState("admin_note")?.visible).toBe(true);
    expect(element.values.region).toBe("none");
  });

  it("a change updates the form in place and keeps what was typed", async () => {
    const element = document.createElement("datum-form") as DatumFormElement;
    element.definition = definition();
    document.body.append(element);
    const root = await paintedForm(element);
    expect(shown(root, "admin_note")).toBe(false);
    type(control(root, "name"), "Ada");
    await until(() => element.values.name === "Ada");
    const runtime = element.runtime;

    element.hostContext = { role: "admin", region: "QC" };
    await until(() => shown(root, "admin_note"));
    expect(element.runtime).toBe(runtime);
    expect(element.values.name).toBe("Ada");
    expect(element.values.region).toBe("QC");
    expect(element.hostContext).toEqual({ role: "admin", region: "QC" });

    // The attribute form, then cleared.
    element.setAttribute("host-context", JSON.stringify({ role: "user" }));
    await until(() => !shown(root, "admin_note"));
    expect(element.hostContext).toEqual({ role: "user" });
    element.removeAttribute("host-context");
    await until(() => element.hostContext === undefined && element.values.region === "none");
    expect(element.runtime).toBe(runtime);
    expect(element.values.name).toBe("Ada");
  });

  it("never sends the host context in the submission", async () => {
    const element = document.createElement("datum-form") as DatumFormElement;
    element.hostContext = { role: "user", secret: "ZZHOSTZZ" };
    element.definition = definition();
    const submits: DatumFormSubmitDetail[] = [];
    element.addEventListener("datum-submit", (event) => submits.push((event as CustomEvent<DatumFormSubmitDetail>).detail));
    document.body.append(element);
    await paintedForm(element);
    const detail = await element.submit();
    expect(JSON.stringify(detail)).not.toContain("ZZHOSTZZ");
    expect(JSON.stringify(submits)).not.toContain("ZZHOSTZZ");
  });

  it("leaves out what JSON cannot carry, reporting host-context.invalid, and keeps the rest", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const element = document.createElement("datum-form") as DatumFormElement;
    const seen = errors(element);
    element.definition = definition();
    document.body.append(element);
    const root = await paintedForm(element);
    element.hostContext = { role: "admin", fn: () => "x", n: Number.NaN, when: new Date(0), list: [1, Number.POSITIVE_INFINITY] } as never;
    expect(seen.map((detail) => detail.code)).toEqual(["host-context.invalid"]);
    expect(seen[0]!.message).toContain("fn: a function");
    expect(seen[0]!.message).toContain("n: a number JSON cannot carry");
    expect(seen[0]!.message).toContain("when: an object that is not a plain object (Date)");
    expect(element.hostContext).toEqual({ role: "admin", list: [1, null] });
    await until(() => shown(root, "admin_note"));

    // No object at all: reported, and the context is cleared.
    element.hostContext = ["admin"] as never;
    expect(seen.map((detail) => detail.code)).toEqual(["host-context.invalid", "host-context.invalid"]);
    expect(element.hostContext).toBeUndefined();
    await until(() => !shown(root, "admin_note"));

    // Not JSON in the attribute: the JSON code, as every JSON attribute reports it.
    element.setAttribute("host-context", "{nope");
    expect(seen.at(-1)!.code).toBe("attribute.invalid-json");
  });
});

describe("plainHostContext", () => {
  it("copies plain data, keeps an own __proto__ key a key, and bounds depth and size", () => {
    const parsed = JSON.parse('{"__proto__":{"polluted":true},"a":{"b":[1,{"c":null}]}}') as Record<string, unknown>;
    const { context, problems } = plainHostContext(parsed);
    expect(problems).toEqual([]);
    expect(Object.keys(context!)).toEqual(["__proto__", "a"]);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(context).not.toBe(parsed);

    let deep: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < 70; level += 1) {
      deep = { next: deep };
    }
    expect(plainHostContext(deep).problems.some((line) => line.includes("nested deeper than 64 levels"))).toBe(true);
    const cyclic: Record<string, unknown> = { role: "admin" };
    cyclic["self"] = cyclic;
    const bounded = plainHostContext(cyclic);
    expect(bounded.context?.["role"]).toBe("admin");
    expect(bounded.problems.length).toBeGreaterThan(0);
    expect(plainHostContext(null)).toEqual({ context: undefined, problems: [] });
    expect(plainHostContext("admin").problems).toEqual(["hostContext must be a plain object of JSON values, not a string"]);
  });
});
