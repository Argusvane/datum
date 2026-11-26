// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DataSourceSet, ValidationResult, ValidationStage } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import type {
  BindingErrorDetail,
  DateFieldState,
  FieldAdapter,
  FieldEvents,
  FieldState,
  GroupAdapter,
  LiveBinding,
  TextFieldState
} from "../form-engine/render/live/contract.js";
import { lit, type Lit } from "../form-engine/render/live/lit.js";
import { mountLive, type LiveFeature, type LiveForm, type LiveMountOptions, type TraceEntry } from "../form-engine/render/live/mount.js";
import { hideConstructedSheets } from "./setup/constructed-sheets.js";

/*
 * The live renderer's draw loop (render/live/mount.ts): the DOM contract and the
 * state hooks on every field wrapper, the write guard for read-only and disabled, the mounted
 * guard, one draw per runtime change, the lookup chain with Datum's fallbacks and the renderer's
 * note, the hook order, the ready budget, the fail-loud mount, focus, and the extension points.
 *
 * The roots here take no constructed sheets (hideConstructedSheets): the renderer's own sheets go
 * in as <style> elements, and one case stubs the property (in the test, never in the source).
 */

// ── Bindings drawn through createBinding(lit), as a binding module does ────────────────────

/** Every `on` an adapter was handed, by instance key: a design system's component can report a change the markup never could. */
const handed = new Map<string, FieldEvents>();

function textAdapter({ html, nothing, live, ifDefined }: Lit, name: string, extra: Partial<FieldAdapter<TextFieldState>> = {}): FieldAdapter<TextFieldState> {
  return {
    kind: "field",
    name,
    capabilities: { notice: "drawn", pending: "drawn", tooltip: "degraded", hideLabel: "drawn", characterCount: "drawn" },
    template: (s, on) => {
      handed.set(s.key, on);
      return html`<label id=${s.labelId} for=${s.id}>${s.label}</label>
        ${s.hint !== undefined ? html`<p id=${ifDefined(s.hintId)} class="hint">${s.hint}</p>` : nothing}
        <input
          id=${s.id}
          class=${name}
          .value=${live(s.value)}
          ?readonly=${s.readOnly}
          ?disabled=${s.disabled}
          aria-describedby=${ifDefined(s.describedBy.length > 0 ? s.describedBy.join(" ") : undefined)}
          aria-invalid=${ifDefined(s.invalid ? "true" : undefined)}
          @input=${(event: Event) => on.input((event.target as HTMLInputElement).value, { interim: true })}
          @change=${() => on.commit()}
        />
        ${s.errors.length > 0 ? html`<p id=${ifDefined(s.errorId)} class="error">${s.message}</p>` : nothing}
        ${s.notices.length > 0 ? html`<p id=${ifDefined(s.noticeId)} class="notice">${s.notices.map((notice) => notice.message).join(" ")}</p>` : nothing}`;
    },
    ...extra
  };
}

function createTestBinding(l: Lit, extra: Partial<LiveBinding> = {}): LiveBinding {
  return { id: "test-ds", label: "Test DS", components: { text: textAdapter(l, "ds-text") }, ...extra };
}

/** A stand-in for the Datum binding: what a DS binding falls back to. */
function createDatumStandIn(l: Lit): LiveBinding {
  const { html, live, nothing } = l;
  const date: FieldAdapter<DateFieldState> = {
    kind: "field",
    name: "datum-date",
    template: (s, on) => {
      handed.set(s.key, on);
      return html`<fieldset><legend id=${s.labelId}>${s.label}</legend>
        <input id=${`${s.id}-day`} class="day" .value=${live(s.value.slice(8, 10))} @input=${(event: Event) => on.parts({ day: (event.target as HTMLInputElement).value, month: "", year: "" })} />
      </fieldset>`;
    }
  };
  const fieldset: GroupAdapter = {
    kind: "group",
    name: "datum-fieldset",
    template: (s, children) => html`<fieldset class="datum-fieldset">${s.legend !== undefined ? html`<legend>${s.legend}</legend>` : nothing}${children}</fieldset>`
  };
  const select: FieldAdapter = {
    kind: "field",
    name: "datum-select",
    template: (s) => html`<label for=${s.id}>${s.label}</label><select id=${s.id}></select>`
  };
  return {
    id: "datum",
    label: "Datum",
    css: ".datum-fieldset { border: 0; }",
    components: { text: textAdapter(l, "datum-text"), date, fieldset, select }
  };
}

// ── Forms and mounts ───────────────────────────────────────────────────────────────────────

function definitionOf(children: ComponentNode[], extra: Partial<FormDefinition> = {}): FormDefinition {
  return { id: "f", version: "1", schemaVersion: "1", root: { id: "root", type: "form", configuration: {}, children: { content: children } }, ...extra };
}

function runtimeOf(definition: FormDefinition, stages?: ValidationStage[]): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline(stages ?? [createFieldConstraintsStage(definition.root)]) });
}

interface Mounted {
  runtime: FormRuntime;
  host: HTMLElement;
  root: ShadowRoot;
  form: LiveForm;
  errors: BindingErrorDetail[];
}

const forms: LiveForm[] = [];

function mountOf(definition: FormDefinition, options: Partial<LiveMountOptions> & { runtime?: FormRuntime } = {}): Mounted {
  const runtime = options.runtime ?? runtimeOf(definition);
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const errors: BindingErrorDetail[] = [];
  host.addEventListener("datum-binding-error", (event) => errors.push((event as CustomEvent<BindingErrorDetail>).detail));
  const form = mountLive(root, { binding: createTestBinding(lit), datum: createDatumStandIn(lit), ...options, runtime });
  forms.push(form);
  return { runtime, host, root, form, errors };
}

async function mounted(definition: FormDefinition, options: Partial<LiveMountOptions> & { runtime?: FormRuntime } = {}): Promise<Mounted> {
  const m = mountOf(definition, options);
  await m.form.ready;
  return m;
}

/** Lets queued work run (a macrotask drains the microtasks first), then waits for the draws. */
async function settled(form: LiveForm): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await form.updated();
}

const wrapper = (root: ShadowRoot, id: string): HTMLElement => root.querySelector<HTMLElement>(`.datum-live-field[data-component-id="${id}"]`) as HTMLElement;
const input = (root: ShadowRoot, id: string): HTMLInputElement => wrapper(root, id).querySelector("input") as HTMLInputElement;

function type(element: HTMLInputElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

let restoreSheets = (): void => undefined;
beforeEach(() => {
  restoreSheets = hideConstructedSheets();
});

afterEach(() => {
  restoreSheets();
  for (const form of forms.splice(0)) {
    form.unmount();
  }
  handed.clear();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const quiet = (): void => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
};

// ── The DOM contract and the state hooks ───────────────────────────────────────────────────

describe("live mount: the DOM contract and the state hooks", () => {
  it("draws every field in a wrapper carrying its component id, value path, instance and kind, and every container in a wrapper of its own", async () => {
    quiet();
    const { root, form } = await mounted(
      definitionOf([
        { id: "you", type: "fieldset", configuration: { label: "You" }, children: { content: [{ id: "name", type: "text", configuration: { label: "Name", required: true } }] } },
        { id: "home", type: "container", configuration: { dataKey: "address" }, children: { content: [{ id: "city", type: "text", configuration: { label: "City" } }] } }
      ])
    );
    const name = wrapper(root, "name");
    // The form lists what it drew, for a host that checks the DOM against it (the feature-coverage harness).
    expect(form.fields().map((field) => field.state.valuePath)).toEqual(["name", "address.city"]);
    expect(form.tree()?.nodes.length).toBeGreaterThan(0);
    expect(name.getAttribute("data-value-path")).toBe("name");
    expect(name.getAttribute("data-instance")).toBe("name");
    expect(name.getAttribute("data-kind")).toBe("text");
    expect(name.hasAttribute("data-required")).toBe(true);
    for (const hook of ["data-invalid", "data-readonly", "data-disabled", "data-over-limit", "data-source", "data-pending"]) {
      expect(name.hasAttribute(hook), hook).toBe(false);
    }
    // A data-scoped field's wrapper says where its answer lives, not just its id.
    expect(wrapper(root, "city").getAttribute("data-value-path")).toBe("address.city");
    const you = root.querySelector<HTMLElement>('[data-container-id="you"]');
    expect(you?.getAttribute("data-kind")).toBe("fieldset");
    expect(you?.classList.contains("datum-live-container")).toBe(true);
    expect(you?.querySelector(".datum-fieldset legend")?.textContent).toBe("You");
    expect(you?.contains(name)).toBe(true);
    expect(root.querySelector('[data-container-id="home"]')).not.toBeNull();
    // The renderer's structure: the container wrapper lays nothing out.
    expect(Array.from(root.querySelectorAll("style[data-datum-live]")).some((style) => style.textContent?.includes(".datum-live-container { display: contents; }"))).toBe(true);
  });

  it("marks a blocking error as invalid and describes the control by it; a notice describes without invalidating", async () => {
    const warning: ValidationStage = {
      id: "advice",
      version: "1",
      validate: () => ({ errors: [{ code: "short", componentId: "nick", path: "nick", severity: "warning", stage: "advice", source: "client" }] })
    };
    const definition = definitionOf([
      { id: "name", type: "text", configuration: { label: "Name", required: true, description: "As written" } },
      { id: "nick", type: "text", configuration: { label: "Nickname", messages: { short: "That is short." } } }
    ]);
    const { root, runtime, form } = await mounted(definition, { runtime: runtimeOf(definition, [createFieldConstraintsStage(definition.root), warning]) });
    await runtime.validate();
    await settled(form);
    const name = wrapper(root, "name");
    expect(name.hasAttribute("data-invalid")).toBe(true);
    const box = input(root, "name");
    expect(box.getAttribute("aria-invalid")).toBe("true");
    const describedBy = (box.getAttribute("aria-describedby") ?? "").split(" ");
    const error = name.querySelector(".error");
    expect(error?.textContent).not.toBe("");
    expect(describedBy).toContain(error?.id);
    expect(describedBy).toContain(name.querySelector(".hint")?.id);
    for (const id of describedBy) {
      expect(root.getElementById(id), id).not.toBeNull();
    }
    const nick = wrapper(root, "nick");
    expect(nick.hasAttribute("data-invalid")).toBe(false);
    expect(input(root, "nick").hasAttribute("aria-invalid")).toBe(false);
    const notice = nick.querySelector(".notice");
    expect(notice?.textContent).toBe("That is short.");
    expect(input(root, "nick").getAttribute("aria-describedby")).toContain(notice?.id);
  });

  it("writes read-only, disabled, over-limit and the failed source on the wrapper", async () => {
    quiet();
    const sources = { has: () => true, ids: () => ["cities"], load: async () => Promise.reject(new Error("down")) } as unknown as DataSourceSet;
    const { root, runtime, form } = await mounted(
      definitionOf([
        { id: "kept", type: "text", configuration: { label: "Kept", readOnly: true } },
        { id: "off", type: "text", configuration: { label: "Off", disabled: true } },
        { id: "bio", type: "text", configuration: { label: "Bio", maxLength: 3, characterCount: true } },
        { id: "city", type: "select", configuration: { label: "City", data: { sourceId: "cities" } } }
      ]),
      { dataSources: sources }
    );
    expect(wrapper(root, "kept").hasAttribute("data-readonly")).toBe(true);
    expect(wrapper(root, "kept").hasAttribute("data-disabled")).toBe(false);
    expect(wrapper(root, "off").hasAttribute("data-disabled")).toBe(true);
    expect(wrapper(root, "bio").hasAttribute("data-over-limit")).toBe(false);
    runtime.setValue("bio", "abcd");
    await settled(form);
    expect(wrapper(root, "bio").hasAttribute("data-over-limit")).toBe(true);
    expect(wrapper(root, "city").getAttribute("data-source")).toBe("error");
  });

  it("marks a field pending while an async check of its path runs, and the form busy while the whole form is checked", async () => {
    let answer!: (result: ValidationResult) => void;
    const remote: ValidationStage = {
      id: "remote",
      version: "1",
      kind: "async",
      paths: () => ["email"],
      validate: () => new Promise<ValidationResult>((resolve) => (answer = resolve))
    };
    const definition = definitionOf([{ id: "email", type: "text", configuration: { label: "Email" } }]);
    const { root, runtime, form } = await mounted(definition, { runtime: runtimeOf(definition, [remote]) });
    const run = runtime.validate();
    await settled(form);
    const email = wrapper(root, "email");
    expect(email.hasAttribute("data-pending")).toBe(true);
    expect(email.getAttribute("aria-busy")).toBe("true");
    expect(root.querySelector("form")?.getAttribute("aria-busy")).toBe("true");
    answer({ errors: [] });
    await run;
    await settled(form);
    expect(email.hasAttribute("data-pending")).toBe(false);
    expect(email.hasAttribute("aria-busy")).toBe(false);
    expect(root.querySelector("form")?.hasAttribute("aria-busy")).toBe(false);
  });
});

// ── The write guard ────────────────────────────────────────────────────────────────────────

describe("live mount: the write guard", () => {
  const definition = () => definitionOf([{ id: "name", type: "text", configuration: { label: "Name" } }, { id: "kept", type: "text", configuration: { label: "Kept", readOnly: true } }]);

  it("takes what is typed into a live field", async () => {
    const { root, runtime, form } = await mounted(definition());
    type(input(root, "name"), "Ann");
    expect(runtime.state().values["name"]).toBe("Ann");
    await settled(form);
    expect(input(root, "name").value).toBe("Ann");
  });

  it("drops a write to a read-only field and draws the stored answer back", async () => {
    const { root, runtime } = await mounted(definition());
    type(input(root, "kept"), "Changed");
    expect(runtime.state().values["kept"]).toBeUndefined();
    expect(input(root, "kept").value).toBe("");
    // A component that reports a change its markup could not stop is refused the same way.
    handed.get("kept")?.input("Sneaked");
    handed.get("kept")?.commit();
    expect(runtime.state().values["kept"]).toBeUndefined();
  });

  it("drops every write while the whole form is read-only or disabled", async () => {
    for (const mode of ["readonly", "disabled"] as const) {
      const { root, runtime } = await mounted(definition(), { mode });
      const name = wrapper(root, "name");
      expect(name.hasAttribute(mode === "readonly" ? "data-readonly" : "data-disabled")).toBe(true);
      type(input(root, "name"), "Ann");
      handed.get("name")?.parts({ year: "2020", month: "1", day: "2" });
      expect(runtime.state().values["name"]).toBeUndefined();
      expect(input(root, "name").value).toBe("");
      expect(root.querySelector("form")?.getAttribute("data-mode")).toBe(mode);
    }
  });

  it("wraps a feature's event patch inside the guard, so a read-only field never reaches it", async () => {
    const reached: unknown[] = [];
    const upper: LiveFeature = {
      id: "upper",
      fieldEvents: (on) => ({
        ...on,
        input: (value, options) => {
          reached.push(value);
          on.input(String(value).toUpperCase(), options);
        }
      })
    };
    const { root, runtime } = await mounted(definition(), { features: [upper] });
    type(input(root, "name"), "ann");
    expect(runtime.state().values["name"]).toBe("ANN");
    type(input(root, "kept"), "x");
    expect(reached).toEqual(["ann"]);
  });
});

// ── The mounted guard and the draw loop ────────────────────────────────────────────────────

describe("live mount: the mounted guard and one draw per change", () => {
  it("draws once per runtime change, however many events the change publishes", async () => {
    const { runtime, form } = await mounted(definitionOf([{ id: "name", type: "text", configuration: { label: "Name", required: true } }]));
    const before = form.draws();
    runtime.setValue("name", "A");
    await settled(form);
    expect(form.draws()).toBe(before + 1);
    runtime.setValue("name", "AB");
    runtime.setValue("name", "ABC");
    await settled(form);
    expect(form.draws()).toBe(before + 2);
  });

  it("draws nothing, writes nothing and emits nothing after unmount, a build already asked for included", async () => {
    const cleanups: string[] = [];
    const watcher: LiveFeature = { id: "watch", connectField: (_wrapper, field) => () => cleanups.push(field.key), start: () => () => cleanups.push("stopped") };
    const { root, runtime, form, errors } = await mounted(definitionOf([{ id: "name", type: "text", configuration: { label: "Name" } }]), { features: [watcher] });
    await settled(form);
    const on = handed.get("name");
    const draws = form.draws();
    runtime.setValue("name", "late");
    form.unmount();
    await settled(form);
    expect(form.draws()).toBe(draws);
    expect(root.querySelector("form")).toBeNull();
    expect(root.querySelector("style[data-datum-live]")).toBeNull();
    expect(cleanups).toEqual(["name", "stopped"]);
    on?.input("after unmount");
    expect(runtime.state().values["name"]).toBe("late");
    runtime.setValue("name", "later");
    await settled(form);
    expect(form.draws()).toBe(draws);
    expect(errors).toEqual([]);
    // A second unmount does nothing.
    form.unmount();
  });

  it("holds the draw while an input method is composing, and draws once it ends", async () => {
    const { root, runtime, form } = await mounted(definitionOf([{ id: "name", type: "text", configuration: { label: "Name" } }]));
    const box = input(root, "name");
    box.dispatchEvent(new Event("compositionstart", { bubbles: true, composed: true }));
    const draws = form.draws();
    runtime.setValue("name", "かな");
    await settled(form);
    expect(form.draws()).toBe(draws);
    box.dispatchEvent(new Event("compositionend", { bubbles: true, composed: true }));
    await settled(form);
    expect(form.draws()).toBe(draws + 1);
  });
});

// ── The lookup chain, fallbacks and reports ────────────────────────────────────────────────

describe("live mount: adapters, fallbacks and unsupported()", () => {
  it("draws a tier-2 type through its base: Datum's adapter when the binding has none, tinted and reported", async () => {
    quiet();
    const definition = definitionOf([{ id: "born", type: "acme-date", configuration: { label: "Born" } }], { kinds: { "acme-date": "date" } });
    const { root, form } = await mounted(definition, { binding: createTestBinding(lit, { fallbackTokens: { "--datum-color-text": "var(--ds-ink)" } }) });
    const born = wrapper(root, "born");
    expect(born.getAttribute("data-kind")).toBe("date");
    expect(born.hasAttribute("data-fallback")).toBe(true);
    expect(born.querySelector("input.day")).not.toBeNull();
    expect(form.adapterOf("born")).toMatchObject({ from: "datum-base", via: "date", name: "datum-date" });
    expect(form.unsupported()).toContain('born: component "acme-date"');
    expect(Array.from(root.querySelectorAll("style[data-datum-live]")).some((style) => style.textContent?.includes("[data-fallback] { --datum-color-text: var(--ds-ink); }"))).toBe(true);
  });

  it("draws a type of the binding's own over its base, and the base when the binding has the base", async () => {
    const definition = definitionOf([{ id: "born", type: "acme-date", configuration: { label: "Born" } }], { kinds: { "acme-date": "date" } });
    const own = createTestBinding(lit);
    const byType = await mounted(definition, { binding: { ...own, components: { ...own.components, "acme-date": textAdapter(lit, "acme-own") } } });
    expect(byType.form.adapterOf("born")).toMatchObject({ from: "binding", via: "acme-date" });
    expect(byType.form.unsupported()).toEqual([]);
    const byBase = await mounted(definition, { binding: { ...own, components: { ...own.components, date: textAdapter(lit, "ds-date") } } });
    expect(byBase.form.adapterOf("born")).toMatchObject({ from: "binding-base", via: "date" });
    expect(wrapper(byBase.root, "born").hasAttribute("data-fallback")).toBe(false);
  });

  it("draws the renderer's note in place of a type nothing draws, with the DOM contract kept", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { root, form } = await mounted(definitionOf([{ id: "w", type: "fancy-widget", configuration: { label: "W" } }, { id: "w2", type: "fancy-widget", configuration: {} }]));
    const note = wrapper(root, "w");
    expect(note.getAttribute("data-kind")).toBe("unknown");
    expect(note.querySelector('[role="note"]')?.textContent).toContain("Unknown component “fancy-widget”");
    expect(form.unsupported()).toEqual(expect.arrayContaining(['w: component "fancy-widget"', 'w2: component "fancy-widget"']));
    expect(form.adapterOf("w")).toEqual({ from: "renderer", via: "fancy-widget" });
    expect(warn.mock.calls.filter(([message]) => String(message).includes("fancy-widget"))).toHaveLength(1);
  });

  it("falls back to Datum's adapter when the binding's template throws, and reports it once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = createTestBinding(lit, {
      components: {
        text: { kind: "field", name: "broken", template: () => { throw new Error("boom"); } }
      }
    });
    const { root, runtime, form, errors } = await mounted(definitionOf([{ id: "name", type: "text", configuration: { label: "Name" } }]), { binding: broken });
    expect(wrapper(root, "name").querySelector("input.datum-text")).not.toBeNull();
    expect(form.adapterOf("name")?.from).toBe("datum");
    runtime.setValue("name", "again");
    await settled(form);
    expect(errors.filter((error) => error.hook === "template")).toEqual([{ hook: "template", id: "name", message: "boom" }]);
  });

  it("reports a capability the adapter answers none for, and folds a degraded tooltip into the hint", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { root, form } = await mounted(definitionOf([{ id: "name", type: "text", configuration: { label: "Name", placeholder: "Ann", tooltip: "Your given name" } }]));
    expect(form.unsupported()).toContain("name: placeholder");
    expect(form.unsupported()).not.toContain("name: tooltip");
    const hint = wrapper(root, "name").querySelector(".hint");
    expect(hint?.textContent).toBe("Your given name");
    expect(input(root, "name").getAttribute("aria-describedby")).toContain(hint?.id);
  });

  it("lists in selfCheck() each instance's adapter, what the form uses that nothing draws, and the binding's own findings", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let findings = ["a sheet is missing"];
    const checked = createTestBinding(lit, { designSystem: { selfCheck: () => findings } as never });
    const definition = definitionOf([
      { id: "name", type: "text", configuration: { label: "Name", placeholder: "Ann" } },
      { id: "born", type: "date", configuration: { label: "Born" } },
      { id: "w", type: "fancy-widget", configuration: { label: "W" } }
    ]);
    const { form } = await mounted(definition, { binding: checked });
    const report = form.selfCheck();
    expect(report.problems).toEqual(["a sheet is missing"]);
    expect(report.unsupported).toEqual(form.unsupported());
    expect(report.unsupported).toEqual(expect.arrayContaining(["name: placeholder", 'w: component "fancy-widget"']));
    const byKey = new Map(report.adapters.map((entry) => [entry.key, entry]));
    expect(byKey.get("name")).toMatchObject({ from: "binding", via: "text", name: "ds-text" });
    expect(byKey.get("born")).toMatchObject({ from: "datum", via: "date", name: "datum-date" });
    expect(byKey.get("w")).toEqual({ key: "w", from: "renderer", via: "fancy-widget" });
    // The check runs again each time it is asked, so a repaired sheet reads clean.
    findings = [];
    expect(form.selfCheck().problems).toEqual([]);
    // A check that answers nothing reads as clean.
    findings = undefined as never;
    expect(() => form.selfCheck()).not.toThrow();
  });

  it("reports in selfCheck() the side effects the binding declares outside the form's root, never as problems", async () => {
    const effects = [{ target: "<html lang>", effect: "the toggle writes the page's language" }];
    const declared = createTestBinding(lit, { designSystem: { name: "DS", sideEffects: effects } });
    const { form } = await mounted(definitionOf([{ id: "name", type: "text", configuration: { label: "Name" } }]), { binding: declared });
    const report = form.selfCheck();
    expect(report.sideEffects).toEqual(effects);
    expect(report.problems).toEqual([]);
    const plain = await mounted(definitionOf([{ id: "name", type: "text", configuration: { label: "Name" } }]), { binding: createTestBinding(lit) });
    expect(plain.form.selfCheck().sideEffects).toEqual([]);
  });

  it("reports a container the binding does not draw, drawn by Datum's container adapter, never flattened", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { root, form } = await mounted(
      definitionOf([{ id: "box", type: "fancy-box", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] } }])
    );
    const box = root.querySelector<HTMLElement>('[data-container-id="box"]');
    expect(box?.querySelector(".datum-fieldset")).not.toBeNull();
    expect(box?.contains(wrapper(root, "name"))).toBe(true);
    expect(form.unsupported()).toContain('box: component "fancy-box"');
  });
});

// ── Lifecycle, budget, failure, focus ──────────────────────────────────────────────────────

describe("live mount: the hooks' order, the ready budget and the fail-loud mount", () => {
  it("runs select, template, render, after, ready, connect in that order, and connect's cleanup when the field leaves", async () => {
    const order: string[] = [];
    const cleanups: string[] = [];
    const binding = createTestBinding(lit, {
      components: {
        text: textAdapter(lit, "ds-text", {
          after: () => void order.push("after:adapter"),
          ready: async () => void order.push("ready:adapter"),
          connect: (_field, state) => {
            order.push("connect:adapter");
            return () => cleanups.push(state.key);
          }
        })
      }
    });
    const trace = (entry: TraceEntry): void => {
      if (entry.id === "name" || entry.hook === "render") {
        order.push(entry.hook);
      }
    };
    const definition = definitionOf([
      { id: "show", type: "checkbox", configuration: { label: "Show" } },
      { id: "name", type: "text", configuration: { label: "Name" }, rules: { visibleWhen: "show = true" } }
    ]);
    const { runtime, form } = await mounted(definition, { binding, trace, features: [] });
    // The first draw holds no "name" (hidden by its rule): only its render was heard.
    expect(order).toEqual(["render"]);
    order.length = 0;
    runtime.setValue("show", true);
    await settled(form);
    const first = order.indexOf("select");
    expect(order.slice(first)).toEqual(["select", "template", "render", "after", "after:adapter", "ready", "ready:adapter", "after:adapter", "connect", "connect:adapter"]);
    runtime.setValue("show", false);
    await settled(form);
    expect(cleanups).toEqual(["name"]);
  });

  it("shows the form with an alert when a field is not ready within the budget, and says so", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const binding = createTestBinding(lit, { components: { text: textAdapter(lit, "ds-text", { ready: () => new Promise<void>(() => undefined) }) } });
    const { root, errors } = await mounted(definitionOf([{ id: "name", type: "text", configuration: { label: "Name" } }]), { binding, readyBudgetMs: 20 });
    expect(errors.map((error) => error.hook)).toContain("ready");
    expect(root.querySelector('.datum-live-alert[role="alert"]')?.textContent).toBe("Part of this form did not finish loading, so it may not work as expected.");
    expect(root.querySelector("form")?.hasAttribute("data-settling")).toBe(false);
  });

  it("keeps the first draw hidden until its fields are ready", async () => {
    let done!: () => void;
    const binding = createTestBinding(lit, { components: { text: textAdapter(lit, "ds-text", { ready: () => new Promise<void>((resolve) => (done = resolve)) }) } });
    const { root, form } = mountOf(definitionOf([{ id: "name", type: "text", configuration: { label: "Name" } }]), { binding });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(root.querySelector("form")?.hasAttribute("data-settling")).toBe(true);
    done();
    await form.ready;
    expect(root.querySelector("form")?.hasAttribute("data-settling")).toBe(false);
  });

  it("puts an alert in the form's place when a feature's preparation fails, and rejects ready", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const assets: LiveFeature = {
      id: "assets",
      prepare: async () => {
        throw Object.assign(new Error("https://cdn.example/ds.css could not be fetched"), { url: "https://cdn.example/ds.css" });
      }
    };
    const { root, form, errors } = mountOf(definitionOf([{ id: "name", type: "text", configuration: { label: "Name" } }]), { features: [assets] });
    await expect(form.ready).rejects.toThrow("could not be fetched");
    expect(root.querySelector("form")).toBeNull();
    expect(root.querySelector('[role="alert"]')?.textContent).toBe("This form could not be shown. Check the connection and try again.");
    expect(errors).toEqual([{ hook: "assets", message: "https://cdn.example/ds.css could not be fetched", url: "https://cdn.example/ds.css" }]);
  });
});

describe("live mount: focus", () => {
  it("focuses the adapter's target, and the wrapper when focus does not land, reporting the miss", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stray = document.createElement("button");
    document.body.append(stray);
    const binding = createTestBinding(lit, {
      components: {
        text: [
          textAdapter(lit, "aimed", { when: (state) => state.componentId === "name", focusTarget: (field) => field.querySelector("input") }),
          textAdapter(lit, "missing", { focusTarget: () => stray })
        ]
      }
    });
    const { root, form, errors } = await mounted(definitionOf([{ id: "name", type: "text", configuration: { label: "Name" } }, { id: "other", type: "text", configuration: { label: "Other" } }]), { binding });
    expect(form.focusField("name")).toBe(true);
    expect(root.activeElement).toBe(input(root, "name"));
    expect(form.focusField("other")).toBe(true);
    expect(root.activeElement).toBe(wrapper(root, "other"));
    expect(wrapper(root, "other").tabIndex).toBe(-1);
    expect(errors).toEqual([{ hook: "focus", id: "other", message: "focus did not land in the field; its wrapper took it" }]);
    expect(form.focusField("nowhere")).toBe(false);
  });

  it("opens what hides a field through the features before focusing it", async () => {
    const opened: unknown[] = [];
    const tabs: LiveFeature = {
      id: "tabs",
      reveal: (steps) => {
        opened.push(...steps);
        return true;
      }
    };
    const { root, form } = await mounted(
      definitionOf([
        {
          id: "sections",
          type: "tabs",
          configuration: { tabs: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
          children: { a: [{ id: "one", type: "text", configuration: { label: "One" } }], b: [{ id: "two", type: "text", configuration: { label: "Two" } }] }
        }
      ]),
      { features: [tabs] }
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    form.focusField("two");
    expect(opened).toEqual([{ kind: "tab", tabsId: "sections", slotId: "b" }]);
    expect(root.activeElement).toBe(input(root, "two"));
  });
});

// ── Extension points ───────────────────────────────────────────────────────────────────────

describe("live mount: extension points", () => {
  it("lets a feature add field state, fill a region, draw a container kind, hear every draw and every connection", async () => {
    const heard: string[] = [];
    const probe: LiveFeature = {
      id: "probe",
      fieldState: (state): FieldState => ({ ...state, label: `${state.label} (probed)` }),
      region: (region, draw) => (region === "summary-top" ? lit.html`<p class="probe-top">top ${draw.form.locale}</p>` : undefined),
      drawNode: (node, draw) =>
        node.kind === "tabs" ? draw.container(node, node.base, lit.html`<div class="probe-tabs">${node.tabs.map((tab) => draw.nodes(tab.children))}</div>`) : undefined,
      afterDraw: (report) => void heard.push(`draw ${report.draw}: +${report.added.join(",")}`),
      connectField: (_wrapper, field) => void heard.push(`connect ${field.key}`)
    };
    const { root } = await mounted(
      definitionOf([
        { id: "intro", type: "text", configuration: { label: "Intro" } },
        { id: "sections", type: "tabs", configuration: { tabs: [{ id: "a", label: "A" }] }, children: { a: [{ id: "one", type: "text", configuration: { label: "One" } }] } }
      ]),
      { features: [probe] }
    );
    expect(wrapper(root, "intro").querySelector("label")?.textContent).toBe("Intro (probed)");
    const form = root.querySelector("form") as HTMLFormElement;
    expect(form.firstElementChild?.classList.contains("probe-top")).toBe(true);
    expect(form.querySelector(".probe-top")?.textContent).toBe("top en");
    const tabs = root.querySelector('[data-container-id="sections"]');
    expect(tabs?.getAttribute("data-kind")).toBe("tabs");
    expect(tabs?.querySelector(".probe-tabs")?.contains(wrapper(root, "one"))).toBe(true);
    expect(heard).toEqual(["draw 1: +intro,one", "connect intro", "connect one"]);
  });

  it("draws a design system's own tabs type, mapped to the tabs base, as tabs", async () => {
    const drawnTypes: string[] = [];
    const tabsModule: LiveFeature = {
      id: "tabs",
      drawNode: (node, draw) => {
        if (node.kind !== "tabs") {
          return undefined;
        }
        drawnTypes.push(`${node.type}:${node.base}`);
        return draw.container(node, node.base, lit.html`${node.tabs.map((tab) => draw.nodes(tab.children))}`);
      }
    };
    const { root, runtime } = await mounted(
      definitionOf(
        [{ id: "sections", type: "ds-tabs", configuration: { tabs: [{ id: "a", label: "A" }] }, children: { a: [{ id: "one", type: "text", configuration: { label: "One", required: true } }] } }],
        { kinds: { "ds-tabs": "tabs" } }
      ),
      { features: [tabsModule] }
    );
    expect(drawnTypes[0]).toBe("ds-tabs:tabs");
    expect(root.querySelector('[data-container-id="sections"]')?.getAttribute("data-kind")).toBe("tabs");
    // Its field validates as before: the map gives the container no place in the data.
    expect((await runtime.validate()).map((error) => `${error.componentId}:${error.code}`)).toEqual(["one:required"]);
  });

  it("draws a container kind no feature draws plainly in its wrapper, warning once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { root } = await mounted(
      definitionOf([
        { id: "sections", type: "tabs", configuration: { tabs: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }, children: { a: [{ id: "one", type: "text", configuration: { label: "One" } }], b: [{ id: "two", type: "text", configuration: { label: "Two" } }] } }
      ])
    );
    const tabs = root.querySelector('[data-container-id="sections"]');
    expect(tabs?.contains(wrapper(root, "one"))).toBe(true);
    expect(tabs?.contains(wrapper(root, "two"))).toBe(true);
    expect(warn.mock.calls.filter(([message]) => String(message).includes('"tabs" containers'))).toHaveLength(1);
  });

  it("hands every adapter the binding's language pack under the form's words", async () => {
    const binding = createTestBinding(lit, { texts: { en: { workedOut: "Calculated for you" } } });
    const seen: string[] = [];
    const reader: LiveFeature = { id: "reader", fieldState: (state) => void seen.push(state.words("workedOut"), state.words("dataGridAdd")) };
    await mounted(definitionOf([{ id: "name", type: "text", configuration: { label: "Name" } }]), { binding, features: [reader] });
    expect(seen.slice(0, 2)).toEqual(["Calculated for you", "Add row"]);
    const hosted = await mounted(definitionOf([{ id: "name", type: "text", configuration: { label: "Name" } }]), { binding, features: [reader], texts: { workedOut: "Host words" } });
    expect(hosted.form.draws()).toBeGreaterThan(0);
    expect(seen).toContain("Host words");
  });
});

describe("live mount: the renderer's own sheets", () => {
  it("adopts them as constructable sheets where the root takes them, and takes them back on unmount", async () => {
    class FakeSheet {
      css = "";
      replaceSync(text: string): void {
        this.css = text;
      }
    }
    vi.stubGlobal("CSSStyleSheet", FakeSheet);
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    const existing = new FakeSheet();
    Object.defineProperty(root, "adoptedStyleSheets", { value: [existing], writable: true, configurable: true });
    const form = mountLive(root, { runtime: runtimeOf(definitionOf([])), binding: createTestBinding(lit), datum: createDatumStandIn(lit) });
    await form.ready;
    const sheets = (root as unknown as { adoptedStyleSheets: FakeSheet[] }).adoptedStyleSheets;
    expect(sheets[0]).toBe(existing);
    expect(sheets.some((sheet) => sheet.css.includes(".datum-live-container"))).toBe(true);
    expect(sheets.some((sheet) => sheet.css.includes(".datum-fieldset"))).toBe(true);
    expect(root.querySelector("style")).toBeNull();
    form.unmount();
    expect((root as unknown as { adoptedStyleSheets: FakeSheet[] }).adoptedStyleSheets).toEqual([existing]);
  });
});
