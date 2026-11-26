// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { FormEventType } from "../form-engine/core/events/event-types.js";
import type { DataSourceSet, ValidationResult, ValidationStage } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { buildRuntimeRenderOutput } from "../form-engine/render/core/runtime-render-bridge.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import type { LiveBinding } from "../form-engine/render/live/contract.js";
import { lit } from "../form-engine/render/live/lit.js";
import { createDatumBinding, createDatumFeatures, mountLive } from "../form-engine/render/live/renderer.js";
import { presentationForm } from "./fixtures/presentation-form.js";
import { bindingOf, cleanUp, definitionOf, mounted, pause, quiet, runtimeOf, settled, wrapper } from "./live-extras-kit.js";

/*
 * The phase-2B fixes to the live renderer's draw loop and the runtime under it:
 * - a field checked again on its own keeps its place in `errors()` and in the summary (SUM-02);
 * - a validation run that throws says so (`VALIDATION_FAILED`), and the form's busy state clears;
 * - the worked-out note's id, folded into the hint, is never left in `describedBy`;
 * - a slow data source does not hold the first draw back (a provisional draw, fields loading);
 * - the binding's form-level `connect`: once per mount, an Element scope, its cleanup on unmount,
 *   a failure reported as `datum-binding-error`;
 * - the renderer's entry gives the one Datum feature list.
 */

afterEach(cleanUp);

const text = (id: string, configuration: Record<string, unknown> = {}): ComponentNode => ({ id, type: "text", configuration: { label: id, ...configuration } });

// ── Form order of the errors (SUM-02) ──────────────────────────────────────────────────────

describe("errors stay in form order after a field is checked on its own", () => {
  const order = (errors: readonly { componentId?: string }[]): string[] => errors.map((error) => error.componentId ?? "");

  it("keeps a re-checked field's error where it stood, in errors() and in the summary", async () => {
    const definition = definitionOf([text("name", { required: true, minLength: 3 }), text("bio", { required: true }), text("city", { required: true })]);
    const runtime = runtimeOf(definition);
    await runtime.validate();
    expect(order(runtime.errors())).toEqual(["name", "bio", "city"]);
    // Still wrong, for another reason: the error is replaced, in its place.
    runtime.setValue("name", "x");
    await runtime.validatePath("name");
    expect(runtime.errors().find((error) => error.componentId === "name")?.code).toBe("minLength");
    expect(order(runtime.errors())).toEqual(["name", "bio", "city"]);
    const output = await buildRuntimeRenderOutput(runtime, "interactive");
    expect(Object.keys(output.meta.errorSummary.byComponent)).toEqual(["name", "bio", "city"]);
  });

  it("puts an error found on a field that had none where the tree puts the field", async () => {
    const definition = definitionOf([
      {
        id: "box",
        type: "fieldset",
        configuration: { label: "Box" },
        children: { content: [text("name", { required: true }), text("nick", { minLength: 3 }), text("city", { required: true })] }
      }
    ]);
    const runtime = runtimeOf(definition);
    // A scoped Continue counts as an attempt for its fields, so leaving one checks it.
    await runtime.validate({ scope: "box" });
    expect(order(runtime.errors())).toEqual(["name", "city"]);
    runtime.setValue("nick", "x");
    await runtime.validatePath("nick");
    expect(order(runtime.errors())).toEqual(["name", "nick", "city"]);
    // Fixed: it goes, the rest stand as they were.
    runtime.setValue("nick", "xyz");
    await runtime.validatePath("nick");
    expect(order(runtime.errors())).toEqual(["name", "city"]);
  });

  it("keeps a row's error in its row's place", async () => {
    const definition = definitionOf([
      { id: "items", type: "dataGrid", configuration: { label: "Items" }, children: { content: [text("sku", { required: true, minLength: 3 })] } },
      text("after", { required: true })
    ]);
    const runtime = runtimeOf(definition);
    runtime.setValue("items", [{ sku: "" }, { sku: "" }]);
    await runtime.validate();
    const paths = (): string[] => runtime.errors().map((error) => `${error.componentId}:${error.code}`);
    const before = paths();
    expect(before.at(-1)).toBe("after:required");
    runtime.setValue("items[0].sku", "x");
    await runtime.validatePath("items[0].sku");
    expect(paths()).toEqual(before.map((entry, index) => (index === 0 && entry.startsWith("sku") ? "sku:minLength" : entry)));
  });
});

// ── A run that throws ──────────────────────────────────────────────────────────────────────

describe("a validation run that throws", () => {
  /** An async stage judging `paths` that throws once `down` is set. */
  const service = { down: false };
  const throwing = (paths?: string[]): ValidationStage => ({
    id: "remote",
    version: "1",
    kind: "async",
    ...(paths ? { paths: () => paths } : {}),
    validate: () => (service.down ? Promise.reject(new Error("service down")) : Promise.resolve({ errors: [] }))
  });

  it("publishes VALIDATION_FAILED, and the form is no longer busy", async () => {
    quiet();
    const definition = definitionOf([text("email")]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slowThenThrow: ValidationStage = { id: "remote", version: "1", kind: "async", validate: async () => { await gate; throw new Error("service down"); } };
    const runtime = runtimeOf(definition, [createFieldConstraintsStage(definition.root), slowThenThrow]);
    const failed: unknown[] = [];
    runtime.events().subscribe(FormEventType.VALIDATION_FAILED, (event) => void failed.push(event.data));
    const { root, form } = await mounted(definition, { runtime });
    const run = runtime.validate();
    await settled(form);
    expect(root.querySelector("form")?.getAttribute("aria-busy")).toBe("true");
    release();
    await expect(run).rejects.toThrow("service down");
    await settled(form);
    expect(failed).toEqual([{ message: "service down" }]);
    expect(root.querySelector("form")?.hasAttribute("aria-busy")).toBe(false);
  });

  it("says which path a field's check covered, clears its pending mark and leaves the form not busy", async () => {
    quiet();
    const definition = definitionOf([text("email", { required: true })]);
    const runtime = runtimeOf(definition, [createFieldConstraintsStage(definition.root), throwing(["email"])]);
    const failed: unknown[] = [];
    runtime.events().subscribe(FormEventType.VALIDATION_FAILED, (event) => void failed.push(event.data));
    const { root, form, errors } = await mounted(definition, { runtime });
    // An error shown makes leaving the field check it.
    service.down = false;
    await runtime.validate();
    service.down = true;
    runtime.setValue("email", "a@b.c");
    await expect(runtime.validatePath("email")).rejects.toThrow("service down");
    await settled(form);
    expect(failed).toEqual([{ message: "service down", paths: ["email"] }]);
    expect(wrapper(root, "email").hasAttribute("data-pending")).toBe(false);
    expect(root.querySelector("form")?.hasAttribute("aria-busy")).toBe(false);
    expect(errors.filter((error) => error.hook === "validatePath")).toEqual([]);
  });

  it("is reported when the renderer's own leave-field check throws", async () => {
    quiet();
    const definition = definitionOf([text("email", { required: true })]);
    const runtime = runtimeOf(definition, [createFieldConstraintsStage(definition.root), throwing(["email"])]);
    const { root, form, errors } = await mounted(definition, { runtime });
    service.down = false;
    await runtime.validate();
    service.down = true;
    await settled(form);
    const box = wrapper(root, "email").querySelector("input") as HTMLInputElement;
    box.value = "a@b.c";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.dispatchEvent(new Event("change", { bubbles: true }));
    await settled(form);
    await pause(0);
    expect(errors.filter((error) => error.hook === "validatePath").map((error) => error.message)).toEqual(["service down"]);
    expect(root.querySelector("form")?.hasAttribute("aria-busy")).toBe(false);
  });

  it("leaves a whole-form check busy when only a field's check ends", async () => {
    let answer!: (result: ValidationResult) => void;
    const definition = definitionOf([text("email")]);
    const wide: ValidationStage = { id: "wide", version: "1", kind: "async", validate: () => new Promise<ValidationResult>((resolve) => (answer = resolve)) };
    const runtime = runtimeOf(definition, [wide]);
    const { root, form } = await mounted(definition, { runtime });
    const run = runtime.validate();
    await settled(form);
    runtime.events().publish({ id: "x", type: FormEventType.VALIDATION_FAILED, timestamp: Date.now(), source: "validation", formId: "f", data: { message: "no", paths: ["email"] } });
    await settled(form);
    expect(root.querySelector("form")?.getAttribute("aria-busy")).toBe("true");
    answer({ errors: [] });
    await run;
    await settled(form);
    expect(root.querySelector("form")?.hasAttribute("aria-busy")).toBe(false);
  });
});

// ── describedBy names only what is drawn ───────────────────────────────────────────────────

describe("the ids that describe a control", () => {
  /** The presentation form on its income page, where `income_total` is a worked-out copy. */
  async function incomePage(binding: LiveBinding, features = createDatumFeatures()) {
    quiet();
    const definition = presentationForm();
    const runtime = runtimeOf(definition);
    runtime.startJourney("apply");
    runtime.setValue("email", "ada@example.org");
    expect(await runtime.nextPage()).toMatchObject({ ok: true, pageId: "income" });
    const { root } = await mounted(definition, { runtime, binding, features });
    const copy = wrapper(root, "income_total");
    const control = copy.querySelector("input") as HTMLInputElement;
    const ids = (control.getAttribute("aria-describedby") ?? "").split(" ").filter((id) => id !== "");
    return { root, copy, ids };
  }

  /** A number box that draws its hint and whatever describes it, answering `workedOut` as given. */
  function numberBinding(workedOut?: "drawn" | "degraded" | "none"): LiveBinding {
    const { html, nothing } = lit;
    return bindingOf(lit, undefined, {
      components: {
        number: {
          kind: "field",
          name: "kit-number",
          capabilities: workedOut === undefined ? {} : { workedOut },
          template: (s) =>
            html`<label for=${s.id}>${s.label}</label>${s.hint !== undefined ? html`<span id=${s.hintId ?? nothing}>${s.hint}</span>` : nothing}<input id=${s.id} aria-describedby=${s.describedBy.length > 0 ? s.describedBy.join(" ") : nothing} />`
        }
      }
    });
  }

  it("name the worked-out line, which the Datum binding draws as its own element", async () => {
    const { root, copy, ids } = await incomePage(createDatumBinding());
    expect(ids).toEqual(["income_total__worked-out"]);
    const line = root.getElementById("income_total__worked-out") as HTMLElement;
    expect(line.textContent).toBe("Worked out from your answers");
    expect(line.hasAttribute("data-worked-out")).toBe(true);
    // Drawn once: the renderer adds no line of its own for an adapter that draws it.
    expect(copy.querySelectorAll("[data-worked-out]").length).toBe(1);
    expect(copy.querySelector(".datum-live-worked-out")).toBeNull();
  });

  it("name the worked-out line the renderer draws in the wrapper when the adapter does not draw it", async () => {
    const { root, copy, ids } = await incomePage(numberBinding(), []);
    expect(ids).toEqual(["income_total__worked-out"]);
    const line = root.getElementById("income_total__worked-out") as HTMLElement;
    expect(line.classList.contains("datum-live-worked-out")).toBe(true);
    expect(line.textContent).toBe("Worked out from your answers");
    // After the adapter's drawing, inside the field's wrapper.
    expect(line.parentElement).toBe(copy);
    expect(copy.lastElementChild).toBe(line);
  });

  it("leave out the worked-out line's id when the adapter folds it into its hint (degraded)", async () => {
    const { root, copy, ids } = await incomePage(numberBinding("degraded"), []);
    expect(ids).not.toContain("income_total__worked-out");
    expect(root.getElementById("income_total__worked-out")).toBeNull();
    expect(copy.querySelector("[data-worked-out]")).toBeNull();
    expect(ids.length).toBe(1);
    expect(root.getElementById(ids[0] as string)?.textContent).toBe("Worked out from your answers");
  });

  it("include a notice's id once the notice is drawn", async () => {
    const advice: ValidationStage = {
      id: "advice",
      version: "1",
      validate: () => ({ errors: [{ code: "short", componentId: "nick", path: "nick", severity: "warning", stage: "advice", source: "client" }] })
    };
    const definition = definitionOf([text("nick", { messages: { short: "That is short." } })]);
    const runtime = runtimeOf(definition, [advice]);
    const { root, form } = await mounted(definition, { runtime, binding: createDatumBinding(), features: createDatumFeatures() });
    await runtime.validate();
    await settled(form);
    const control = wrapper(root, "nick").querySelector("input") as HTMLInputElement;
    const ids = (control.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids).toContain("nick__notice");
    expect(root.getElementById("nick__notice")?.textContent).toContain("That is short.");
  });
});

// ── A slow data source ─────────────────────────────────────────────────────────────────────

describe("the first draw while a data source is out", () => {
  const definition = () => definitionOf([text("name"), { id: "city", type: "select", configuration: { label: "City", data: { sourceId: "cities" } } }]);
  function slowSources(): { sources: DataSourceSet; answer: () => void; asked: () => number } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let asked = 0;
    return {
      sources: {
        has: (id) => id === "cities",
        ids: () => ["cities"],
        load: async () => {
          asked += 1;
          await gate;
          return { items: [{ value: "a", label: "Alpha" }] };
        }
      },
      answer: () => release(),
      asked: () => asked
    };
  }

  it("draws the form at once with the field loading, and again once the source answers", async () => {
    const slow = slowSources();
    const { root, form } = await mounted(definition(), { dataSources: slow.sources, features: createDatumFeatures(), binding: createDatumBinding() });
    // Ready without the source: the field is drawn as loading.
    expect(wrapper(root, "name")).not.toBeNull();
    expect(wrapper(root, "city").getAttribute("data-source")).toBe("loading");
    expect(wrapper(root, "city").getAttribute("aria-busy")).toBe("true");
    expect(root.querySelector("[data-source-note]")?.textContent).toBe("Loading the choices…");
    expect(root.querySelector("form")?.hasAttribute("data-settling")).toBe(false);
    slow.answer();
    await settled(form);
    expect(wrapper(root, "city").hasAttribute("data-source")).toBe(false);
    expect(Array.from(wrapper(root, "city").querySelectorAll("option")).map((option) => option.textContent)).toContain("Alpha");
  });

  it("waits for the sources first when the host asks it to (dataSourceWait: all)", async () => {
    const slow = slowSources();
    const runtime = runtimeOf(definition());
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    const form = mountLive(root, { runtime, binding: bindingOf(lit), datum: createDatumBinding(), dataSources: slow.sources, dataSourceWait: "all" });
    let ready = false;
    void form.ready.then(() => (ready = true));
    await pause(20);
    expect(ready).toBe(false);
    expect(form.draws()).toBe(0);
    slow.answer();
    await form.ready;
    expect(wrapper(root, "city").hasAttribute("data-source")).toBe(false);
    form.unmount();
  });

  it("draws nothing provisional for a source that answers in time", async () => {
    const sources: DataSourceSet = { has: (id) => id === "cities", ids: () => ["cities"], load: async () => ({ items: [{ value: "a", label: "Alpha" }] }) };
    const { root, form } = await mounted(definition(), { dataSources: sources, binding: createDatumBinding(), features: createDatumFeatures() });
    expect(form.draws()).toBe(1);
    expect(wrapper(root, "city").hasAttribute("data-source")).toBe(false);
  });
});

// ── The binding's form-level start ─────────────────────────────────────────────────────────

describe("the binding's form-level connect", () => {
  function startingBinding(start: NonNullable<LiveBinding["connect"]>): LiveBinding {
    return { ...bindingOf(lit), connect: start };
  }

  it("is called once per mount with the form element as the scope, never on a redraw, and cleaned up on unmount", async () => {
    const calls: Array<{ root: ShadowRoot; scope: Element }> = [];
    let cleaned = 0;
    const binding = startingBinding((root, scope) => {
      calls.push({ root, scope });
      return () => {
        cleaned += 1;
      };
    });
    const { root, runtime, form } = await mounted(definitionOf([text("name")]), { binding });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.root).toBe(root);
    expect(calls[0]?.scope).toBeInstanceOf(HTMLFormElement);
    expect(calls[0]?.scope).toBe(root.querySelector("form"));
    runtime.setValue("name", "Ann");
    await settled(form);
    form.redraw();
    await runtime.validate();
    await settled(form);
    expect(calls).toHaveLength(1);
    expect(cleaned).toBe(0);
    form.unmount();
    expect(cleaned).toBe(1);
  });

  it("reports a start that throws as datum-binding-error and keeps the form drawn", async () => {
    quiet();
    const binding = startingBinding(() => {
      throw new Error("SupportError: GOV.UK Frontend is not supported in this browser");
    });
    const { root, errors } = await mounted(definitionOf([text("name")]), { binding });
    expect(errors).toEqual([{ hook: "connect", message: "SupportError: GOV.UK Frontend is not supported in this browser" }]);
    expect(wrapper(root, "name")).not.toBeNull();
  });

  it("keeps the cleanup an async start resolves to, and reports one that rejects", async () => {
    quiet();
    let cleaned = 0;
    const asyncStart = startingBinding(async () => () => {
      cleaned += 1;
    });
    const started = await mounted(definitionOf([text("name")]), { binding: asyncStart });
    await pause(0);
    started.form.unmount();
    expect(cleaned).toBe(1);
    const rejecting = await mounted(definitionOf([text("name")]), { binding: startingBinding(async () => Promise.reject(new Error("script did not load"))) });
    await pause(0);
    expect(rejecting.errors).toEqual([{ hook: "connect", message: "script did not load" }]);
  });

  it("runs a cleanup that arrives after unmount at once", async () => {
    let finish!: (stop: () => void) => void;
    let cleaned = 0;
    const binding = startingBinding(() => new Promise<() => void>((resolve) => (finish = resolve)));
    const { form } = await mounted(definitionOf([text("name")]), { binding });
    form.unmount();
    finish(() => {
      cleaned += 1;
    });
    await pause(0);
    expect(cleaned).toBe(1);
  });
});

// ── The one feature list ───────────────────────────────────────────────────────────────────

describe("the renderer's entry", () => {
  it("gives the Datum binding and the one list of the renderer's modules a host mounts it with", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ids = createDatumFeatures().map((feature) => feature.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["fields", "tooltips", "announcer", "sources", "buttons", "files", "summary", "tabs", "steps"]));
    expect(createDatumBinding().id).toBe("datum");
  });
});
