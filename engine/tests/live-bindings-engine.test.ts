// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * What bindings and plugins need from the engine: a component's own
 * texts worded through the form's translations, tier-2 types read as their base and written into
 * the definition's `kinds` map, the form's heading level on every state that draws a heading, a
 * binding registered with its design system's files, the receipt's kind word and the binding's
 * language pack under the form's own words, and the journey worked-out line as its own element.
 */
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import { addressOf, writeTranslation, type FormTranslations } from "../form-engine/core/localization/translations.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import type { FormNotice } from "../form-engine/core/submission/form-notice.js";
import { componentDrawingOf, isEmptyDrawing, withComponentDrawing } from "../form-engine/plugins/component-adapters.js";
import { definitionKindsFor, offeredKinds } from "../form-engine/registry/kinds.js";
import { resetAssetCaches } from "../form-engine/render/live/assets.js";
import { DATUM_STYLES } from "../form-engine/render/live/datum/css.js";
import { datumFile } from "../form-engine/render/live/datum/file.js";
import { bindingAssetsById, bindingById, onBindingsChanged, registerBinding } from "../form-engine/render/live/binding-registry.js";
import { chromeFeature } from "../form-engine/render/live/chrome.js";
import { componentTextOf } from "../form-engine/render/live/component-text.js";
import type { ChromeState, FieldAdapter, FormNoticeState, GroupAdapter, LiveBinding } from "../form-engine/render/live/contract.js";
import { createFormNoticesFeature } from "../form-engine/render/live/form-notices.js";
import { createJourneyPageFeature } from "../form-engine/render/live/journey-page.js";
import { lit } from "../form-engine/render/live/lit.js";
import { createDatumBinding, createDatumFeatures } from "../form-engine/render/live/renderer.js";
import { defineDatumFormRendererElement, DATUM_FORM_RENDERER_TAG, type DatumFormRendererElement } from "../form-engine/render/web-component/form-renderer-element.js";
import { runKernel } from "../form-engine/validation/wasm/portable-kernel.js";
import { presentationForm } from "./fixtures/presentation-form.js";
import { cleanUp, definitionOf, mounted, quiet, runtimeOf, settled, textAdapter, wrapper } from "./live-extras-kit.js";

const { html, nothing } = lit;

afterEach(cleanUp);

const TWO_LOCALES = { localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] } };

function translated(...entries: Array<[owner: string, property: string, text: string, source: string]>): FormTranslations {
  let map: FormTranslations = {};
  for (const [owner, property, text, source] of entries) {
    map = writeTranslation(map, "fr", addressOf.component(owner, property), text, source);
  }
  return map;
}

// ── (a) A component's own texts ─────────────────────────────────────────────────────────────

describe("FieldState.text and GroupState.text", () => {
  const CARD: ComponentNode = { id: "card", type: "acme-card", configuration: { title: "Opening hours", count: 3, empty: "", list: ["a"] } };
  const BOX: ComponentNode = {
    id: "box",
    type: "fieldset",
    configuration: { label: "Box", note: "Bring your card" },
    children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] }
  };

  function cardBinding(seen: Array<Record<string, string | undefined>>): LiveBinding {
    const card: FieldAdapter = {
      kind: "field",
      name: "acme card",
      template: (s) => {
        seen.push({ title: s.text("title"), count: s.text("count"), empty: s.text("empty"), list: s.text("list"), absent: s.text("absent"), proto: s.text("__proto__") });
        return html`<p data-card>${s.text("title") ?? nothing}</p>`;
      }
    };
    const box: GroupAdapter = {
      kind: "group",
      name: "acme box",
      template: (s, children) => html`<section data-box><p data-note>${s.text("note") ?? nothing}</p>${children}</section>`
    };
    return { id: "acme", label: "Acme", components: { "acme-card": card, fieldset: box, text: textAdapter(lit) } };
  }

  it("words a plugin type's own property and a container's through the form's translations, following the locale", async () => {
    quiet();
    const seen: Array<Record<string, string | undefined>> = [];
    const definition = definitionOf([CARD, BOX], {
      ...TWO_LOCALES,
      translations: translated(["card", "title", "Heures d'ouverture", "Opening hours"], ["box", "note", "Apportez votre carte", "Bring your card"])
    });
    const { root, runtime, form } = await mounted(definition, { binding: cardBinding(seen) });
    expect(root.querySelector("[data-card]")?.textContent).toBe("Opening hours");
    expect(root.querySelector("[data-note]")?.textContent).toBe("Bring your card");
    // Only a non-empty string is a text: a number, an empty string, a list and an absent property are none.
    expect(seen[0]).toEqual({ title: "Opening hours", count: undefined, empty: undefined, list: undefined, absent: undefined, proto: undefined });
    runtime.setLocale("fr");
    await settled(form);
    expect(root.querySelector("[data-card]")?.textContent).toBe("Heures d'ouverture");
    expect(root.querySelector("[data-note]")?.textContent).toBe("Apportez votre carte");
  });

  it("takes the host catalog's text over the form's, and words a worked-out copy's texts at its target", () => {
    const node: ComponentNode = { id: "card", type: "acme-card", configuration: { title: "Opening hours" } };
    const translations = translated(["card", "title", "Heures", "Opening hours"]);
    expect(componentTextOf(node, "fr", { translations })("title")).toBe("Heures");
    expect(componentTextOf(node, "fr", { translations, catalog: { fr: { components: { card: { title: "Horaires" } } } } })("title")).toBe("Horaires");
    expect(componentTextOf(node, "en", { translations })("title")).toBe("Opening hours");
    const copy: ComponentNode = { id: "copy", type: "text", configuration: { label: "Total", hint: "Added up", presentation: { kind: "worked-out", to: "total" } } };
    const atTarget = translated(["total", "hint", "Additionné", "Added up"]);
    expect(componentTextOf(copy, "fr", { translations: atTarget })("hint")).toBe("Additionné");
    expect(componentTextOf(undefined, "fr", { translations })("title")).toBeUndefined();
  });
});

// ── (b) Tier-2 types: base on the definition, the kinds map on save ──────────────────────────

describe("a tier-2 type's base", () => {
  const def = (type: string, extra: Partial<ComponentDefinition> = {}): ComponentDefinition =>
    ({ type, version: "1.0.0", createDefault: () => ({ id: type, type, configuration: {} }), capabilities: [], ...extra }) as ComponentDefinition;

  it("is offered only as a base the definition's map may hold, the first source naming one winning", () => {
    expect(offeredKinds({ "acme-date": "date", text: "number", "acme-x": "button", "acme-y": 3 }, { "acme-date": "text", "acme-z": "fieldset" }, undefined)).toEqual({
      "acme-date": "date",
      "acme-z": "fieldset"
    });
  });

  it("makes the saved map: every non-engine type used, from the offer, else the map loaded, unused ones dropped", () => {
    const root: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "born", type: "gcds-date", configuration: { label: "Born" } },
          { id: "box", type: "acme-box", configuration: {}, children: { content: [{ id: "n", type: "acme-number", configuration: {} }] } },
          { id: "name", type: "text", configuration: {} }
        ]
      }
    };
    expect(definitionKindsFor(root, { "gcds-date": "date", "acme-box": "panel" }, { "acme-number": "number", "gone-type": "text" })).toEqual({
      "gcds-date": "date",
      "acme-box": "panel",
      "acme-number": "number"
    });
    // The map loaded, when it comes out the same, is handed back as it was.
    const current = { "gcds-date": "date", "acme-box": "panel", "acme-number": "number" };
    expect(definitionKindsFor(root, { "gcds-date": "date" }, current)).toBe(current);
    expect(definitionKindsFor({ id: "form", type: "form", configuration: {}, children: { content: [] } }, { "gcds-date": "date" })).toBeUndefined();
  });

  it("travels on a definition's drawing, laid over the binding's own kinds", () => {
    const drawing = componentDrawingOf([def("acme-date", { base: "date" }), def("acme-bad", { base: "html" }), def("text", { base: "number" })]);
    expect(drawing.kinds).toEqual({ "acme-date": "date" });
    expect(isEmptyDrawing(drawing)).toBe(false);
    const binding = withComponentDrawing({ id: "ds", label: "DS", components: {}, kinds: { "ds-radios": "radio", "acme-date": "text" } }, drawing);
    expect(binding.kinds).toEqual({ "acme-date": "date", "ds-radios": "radio" });
  });

  it("draws a plugin type as its base, reported until the definition's map carries it", async () => {
    quiet();
    const datum = createDatumBinding();
    const binding = withComponentDrawing(datum, componentDrawingOf([def("acme-date", { base: "date" })]));
    const field: ComponentNode = { id: "born", type: "acme-date", configuration: { label: "Born" } };
    const unmapped = await mounted(definitionOf([field]), { binding, datum, features: createDatumFeatures() });
    expect(wrapper(unmapped.root, "born").getAttribute("data-kind")).toBe("date");
    expect(unmapped.form.unsupported().some((entry) => entry.includes('component "acme-date" has no kinds entry'))).toBe(true);
    const mapped = await mounted(definitionOf([field], { kinds: { "acme-date": "date" } }), { binding, datum, features: createDatumFeatures() });
    expect(wrapper(mapped.root, "born").getAttribute("data-kind")).toBe("date");
    expect(mapped.form.unsupported().some((entry) => entry.includes("kinds entry"))).toBe(false);
  });

  it("is written by the builder from the component definitions and the bindings offered, and the sandbox reads the map alone", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "born", type: "acme-date", configuration: { label: "Born" } },
          { id: "colour", type: "gcds-radios", configuration: { label: "Colour", options: [{ value: "red", label: "Red" }] } }
        ]
      }
    };
    const gcds: LiveBinding = { id: "gcds", label: "GC Design System", components: {}, kinds: { "gcds-radios": "radio", "gcds-date": "date" } };
    const ctrl = new BuilderController({
      componentTypes: [{ type: "text", label: "Text" }],
      initialRoot: root,
      componentDefinitions: [def("form", { children: { slots: [{ id: "content", multiple: true }] } }), def("acme-date", { base: "date" }), def("gcds-radios")],
      availableBindings: [{ id: "datum", label: "Datum" }, { id: "gcds", label: "GC Design System", binding: gcds }]
    });
    const kinds = ctrl.definitionKinds();
    expect(kinds).toEqual({ "acme-date": "date", "gcds-radios": "radio" });
    // An entry the form was loaded with for a type nothing on the page offers is kept while used.
    expect(ctrl.definitionKinds({ "acme-date": "text", "gcds-radios": "radio" })).toEqual({ "acme-date": "date", "gcds-radios": "radio" });
    // No binding or plugin code: the portable kernel judges the type as a date from the map.
    const outcome = runKernel({ formId: "f", values: { born: "2026-02-30", colour: "green" }, locale: "en", form: ctrl.snapshot(), kinds: kinds! }, [], undefined, formulaFunctionSignatures());
    expect(outcome.errors.map((error) => `${error.componentId}:${error.code}`).sort()).toEqual(["born:date", "colour:option.notAllowed"]);
  });
});

// ── (c) The form's heading level on the chrome and the page ──────────────────────────────────

describe("the form's heading level", () => {
  it("reaches a chrome adapter's state", async () => {
    const seen: ChromeState[] = [];
    const chrome = { header: [{ id: "hello", type: "heading", text: "Welcome", level: 3 }] };
    const binding: LiveBinding = {
      id: "acme",
      label: "Acme",
      components: { text: textAdapter(lit) },
      chrome: { heading: { template: (state) => (seen.push(state), html`<div data-acme-heading>${state.text}</div>`) } }
    };
    await mounted(definitionOf([], {}), { binding, features: [chromeFeature({ chrome: () => chrome, headingLevel: () => 2 })] });
    expect(seen.at(-1)).toMatchObject({ part: "heading", level: 3, headingLevel: 2 });
    cleanUp();
    seen.length = 0;
    await mounted(definitionOf([]), { binding, features: [chromeFeature({ chrome: () => chrome })] });
    expect(seen.at(-1)?.headingLevel).toBe(1);
  });

  it("heads a journey page at the form's level: Datum's page heading is an h1 by default, the host's level when it says one", async () => {
    quiet();
    const page = async (headingLevel?: number) => {
      const definition = presentationForm();
      const runtime = runtimeOf(definition);
      runtime.startJourney("apply");
      const binding = createDatumBinding();
      const m = await mounted(definition, {
        runtime,
        binding,
        datum: binding,
        features: [...createDatumFeatures(), createJourneyPageFeature()],
        ...(headingLevel !== undefined ? { headingLevel } : {})
      });
      await settled(m.form);
      return m.root.querySelector("[data-journey-heading]");
    };
    expect((await page())?.localName).toBe("h1");
    expect((await page(3))?.localName).toBe("h3");
  });
});

// ── (d) A binding registered with its files ─────────────────────────────────────────────────

describe("bindings registered with their design system's files", () => {
  const ds = (id: string): LiveBinding => ({ id, label: id, components: {} });

  it("keeps the files per id, replaced or cleared with the binding, and tells listeners when they change", () => {
    const heard = vi.fn();
    const stop = onBindingsChanged(heard);
    const binding = ds("files-ds-1");
    const assets = { stylesheets: [{ url: "https://ds.test/one.css" }] };
    registerBinding(binding, { assets });
    expect(bindingById("files-ds-1")).toBe(binding);
    expect(bindingAssetsById("files-ds-1")).toBe(assets);
    expect(heard).toHaveBeenCalledTimes(1);
    // The same binding and files again is no change.
    registerBinding(binding, { assets });
    expect(heard).toHaveBeenCalledTimes(1);
    const next = { stylesheets: [{ url: "https://ds.test/two.css" }] };
    registerBinding(binding, { assets: next });
    expect(bindingAssetsById("files-ds-1")).toBe(next);
    expect(heard).toHaveBeenCalledTimes(2);
    registerBinding(binding);
    expect(bindingAssetsById("files-ds-1")).toBeUndefined();
    expect(heard).toHaveBeenCalledTimes(3);
    expect(bindingAssetsById("datum")).toBeUndefined();
    stop();
  });

  it("are what a form naming the binding by id draws with when it has no files of its own", async () => {
    resetAssetCaches();
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      return { ok: true, status: 200, text: async () => ".acme { color: red; }" };
    });
    registerBinding(ds("files-ds-2"), { assets: { stylesheets: [{ url: "https://ds.test/acme.css" }] } });
    defineDatumFormRendererElement();
    const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
    element.binding = "files-ds-2";
    element.runtime = runtimeOf(definitionOf([{ id: "name", type: "text", configuration: { label: "Name" } }]));
    document.body.append(element);
    await until(() => fetched.includes("https://ds.test/acme.css"));
    // Registered again with other files: the form is drawn again with them.
    registerBinding(bindingById("files-ds-2")!, { assets: { stylesheets: [{ url: "https://ds.test/acme-2.css" }] } });
    await until(() => fetched.includes("https://ds.test/acme-2.css"));
    // The element's own files win over the registered ones.
    element.assets = { stylesheets: [{ url: "https://ds.test/own.css" }] };
    await until(() => fetched.includes("https://ds.test/own.css"));
    element.remove();
  });
});

// ── (e, f) The receipt's kind word and a binding's language pack ─────────────────────────────

describe("the receipt's kind word", () => {
  const receipt: FormNotice = { kind: "success", title: "Received" };

  async function kindWordOf(locale: string, binding: LiveBinding, translations?: FormTranslations): Promise<string> {
    const seen: FormNoticeState[] = [];
    const drawn: LiveBinding = { ...binding, notice: (state) => (seen.push(state), html`<p data-receipt>${state.kindWord} ${state.title}</p>`) };
    const definition = definitionOf([], { ...TWO_LOCALES, ...(translations ? { translations } : {}) });
    const runtime = runtimeOf(definition);
    runtime.setLocale(locale);
    await mounted(definition, { runtime, binding: drawn, features: [createFormNoticesFeature({ notice: () => receipt })] });
    return seen.at(-1)?.kindWord ?? "(not drawn)";
  }

  it("is English by default, the binding's pack in a language it ships, and the form's own translation over both", async () => {
    const binding: LiveBinding = { id: "acme", label: "Acme", components: {}, texts: { fr: { noticeSuccess: "Succès : " } } };
    expect(await kindWordOf("en", binding)).toBe("Success:");
    expect(await kindWordOf("fr", binding)).toBe("Succès :");
    const own = writeTranslation(undefined, "fr", addressOf.formText("noticeSuccess"), "Réussi : ", "Success: ");
    expect(await kindWordOf("fr", binding, own)).toBe("Réussi :");
    // A language the pack does not ship reads the engine's English.
    expect(await kindWordOf("fr", { ...binding, texts: { de: { noticeSuccess: "Erfolg: " } } })).toBe("Success:");
  });
});

// ── (g) The journey worked-out line ─────────────────────────────────────────────────────────

describe("the worked-out line of a journey page", () => {
  it("is its own element under the id the control is described by, apart from the description", async () => {
    quiet();
    const definition = presentationForm();
    const runtime = runtimeOf(definition);
    runtime.startJourney("apply");
    runtime.setValue("email", "ada@example.org");
    await runtime.nextPage();
    const binding = createDatumBinding();
    const { root } = await mounted(definition, { runtime, binding, datum: binding, features: [...createDatumFeatures(), createJourneyPageFeature()] });
    const control = wrapper(root, "income_total").querySelector("input") as HTMLInputElement;
    const ids = (control.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids).toContain("income_total__worked-out");
    const line = root.getElementById("income_total__worked-out");
    expect(line?.textContent).toBe("Worked out from your answers");
    expect(root.querySelector("#income_total__description")?.textContent ?? "").not.toContain("Worked out");
  });
});

// ── (i) Datum's file picker and image ───────────────────────────────────────────────────────

describe("Datum's native file picker and image", () => {
  /** The declarations of the first rule whose selector list is exactly `selector`. */
  const rule = (selector: string): string => {
    const at = DATUM_STYLES.indexOf(`\n  ${selector} {`);
    expect(at, selector).toBeGreaterThan(-1);
    return DATUM_STYLES.slice(at, DATUM_STYLES.indexOf("}", at));
  };

  it("draws the picker's button and line in the form's look, from its tokens", () => {
    expect(rule(".datum-form__control--file::file-selector-button")).toMatch(/border: var\(--width-button-border, 1px\) solid var\(--color-accent, #2f6feb\)/);
    expect(rule(".datum-form__control--file::file-selector-button")).toContain("font: inherit");
    expect(rule(".datum-form__control--file")).toContain("font: inherit");
    expect(rule(".datum-form__control--file:disabled::file-selector-button")).toContain("var(--opacity-button-disabled, .5)");
  });

  it("keeps an image inside the form, and draws a missing one as a dashed frame with its caption", async () => {
    expect(rule(".datum-form__image img")).toContain("max-width: 100%");
    expect(rule(".datum-form__image--empty")).toContain("dashed");
    const binding = createDatumBinding();
    const { root } = await mounted(definitionOf([{ id: "pic", type: "image", configuration: {} }, { id: "doc", type: "file", configuration: { label: "Document" } }]), {
      binding,
      datum: binding,
      features: createDatumFeatures()
    });
    expect(wrapper(root, "pic").querySelector(".datum-form__image--empty .datum-form__image-placeholder")).not.toBeNull();
    // The picker carries the control classes the sheet's rules address.
    expect(wrapper(root, "doc").querySelector("input[type=file]")?.classList.contains("datum-form__control--file")).toBe(true);
    expect(datumFile.capabilities?.workedOut).toBe("drawn");
  });
});

async function until(check: () => boolean, tries = 200): Promise<void> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("never became true");
}
