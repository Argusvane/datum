import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import {
  BUILTIN_ICONS,
  builderThemes,
  createPluginRegistry,
  createThemeRegistry,
  createFormRuntime,
  defaultIconSet,
  mergeComponentDefinitions,
  paletteEntriesOf,
  pluginComponents,
  plugins,
  standardFieldCapabilities,
  versionContextFor,
  withPluginDataSources,
  EMBED_SUBMISSION_MODE,
  type ComponentDefinition,
  type DatumErrorDetail,
  type DatumFormBuilderElement,
  type DatumFormElement,
  type DatumFormReadyDetail,
  type FormDefinition,
  type FormPlugin
} from "../src/builder.js";
import { defineDataSources, type ComponentAdapterFactory } from "@argusvane/datum-engine";
import { createPluginPlatform } from "../src/plugins.js";

import { ACME_CARD_TYPE, ACME_NOTICE_CSS, ACME_NOTICE_TYPE, ACME_PALETTE_GROUP, acmeComponentsPlugin } from "./fixtures/acme-components.js";
import { sampleDefinition, until } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/**
 * A component type of a plugin's own: a row of stars, with its palette entry and its drawing on
 * the definition (`adapter`, a factory handed the renderer's lit).
 */
function ratingDefinition(): ComponentDefinition {
  return {
    type: "rating",
    version: "1.0.0",
    createDefault: () => ({ id: "rating", type: "rating", configuration: { label: "Rating", max: 5 } }),
    capabilities: standardFieldCapabilities({ placeholder: false, description: false }),
    palette: { label: "Rating", icon: "★", group: "Survey" },
    css: [".star-rating__star.is-on { color: goldenrod; }"],
    adapter: ratingAdapter
  };
}

const ratingAdapter: ComponentAdapterFactory = ({ html }) => ({
  kind: "field",
  name: "survey-rating",
  template: (state, on) => {
    const max = Number((state.model.node.configuration as { max?: unknown } | undefined)?.max) || 5;
    const selected = Number(state.answer) || 0;
    return html`<div class="star-rating" role="group" aria-labelledby=${state.labelId}>
      <span id=${state.labelId}>${state.label}</span>
      ${Array.from({ length: max }, (_, index) => html`<button type="button" class=${index < selected ? "star-rating__star is-on" : "star-rating__star"} @click=${() => on.input(index + 1)}>${index + 1}</button>`)}
    </div>`;
  }
});

function surveyDefinition(): FormDefinition {
  return {
    id: "survey",
    version: "1.0.0",
    schemaVersion: "1",
    root: {
      id: "root",
      type: "form",
      configuration: { title: "Survey" },
      children: {
        content: [
          { id: "fullName", type: "text", configuration: { label: "Full name" } },
          { id: "experience", type: "rating", configuration: { label: "How was it?", max: 4 } },
          { id: "submit", type: "button", configuration: { label: "Send", action: "submit" } }
        ]
      }
    }
  };
}

function plugin(id: string, extra: Partial<FormPlugin> = {}): FormPlugin {
  return { id, version: "1.0.0", ...extra };
}

async function ready(element: DatumFormElement): Promise<ShadowRoot> {
  await until(() => element.renderer?.shadowRoot?.querySelector("form"));
  return element.renderer!.shadowRoot!;
}

async function builderReady(element: DatumFormBuilderElement): Promise<void> {
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
}

describe("the plugin registry", () => {
  it("starts empty, registers a plugin once, and tells its listeners only when something was added", () => {
    const registry = createPluginRegistry();
    let notified = 0;
    registry.subscribe(() => {
      notified += 1;
    });
    expect(registry.plugins()).toEqual([]);
    expect(registry.has("survey")).toBe(false);

    const survey = plugin("survey", { components: [ratingDefinition()] });
    registry.register(survey);
    registry.register(survey);
    registry.register([survey, { id: "survey", version: "1.0.0", components: [] }]);
    expect(registry.plugins()).toEqual([survey]);
    expect(registry.has("survey")).toBe(true);
    expect(registry.has("survey", "1.0.0")).toBe(true);
    expect(registry.has("survey", "2.0.0")).toBe(false);
    expect(notified).toBe(1);

    // Not a plugin: ignored, nobody told.
    registry.register({} as unknown as FormPlugin);
    expect(notified).toBe(1);

    // Another version of the same id is another plugin, in registration order.
    registry.register({ id: "survey", version: "2.0.0" }, { assetsBase: "/vendor/" });
    expect(registry.plugins().map((entry) => entry.version)).toEqual(["1.0.0", "2.0.0"]);
    expect(registry.registrations()[1]!.options).toEqual({ assetsBase: "/vendor/" });
    expect(notified).toBe(2);
  });

  it("refuses a plugin whose lists are not lists of objects by name, and keeps serving the others", () => {
    const registry = createPluginRegistry();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let notified = 0;
    registry.subscribe(() => {
      notified += 1;
    });
    const good = plugin("survey", { components: [ratingDefinition()] });
    const malformed: Array<[string, unknown, string]> = [
      ["comp-null", { id: "comp-null", version: "1", components: [null] }, "components[0] must be an object"],
      ["comp-untyped", { id: "comp-untyped", version: "1", components: [{}] }, "components[0].type must be a non-empty string"],
      ["comp-string", { id: "comp-string", version: "1", components: "boom" }, "components must be a list"],
      ["source-null", { id: "source-null", version: "1", dataSources: [null] }, "dataSources[0] must be an object"],
      ["provider-untyped", { id: "provider-untyped", version: "1", dataSourceProviders: [{}] }, "dataSourceProviders[0].id must be a non-empty string"],
      ["builder-themes-five", { id: "builder-themes-five", version: "1", builderThemes: 5 }, "builderThemes must be a list"],
      ["comp-adapter", { id: "comp-adapter", version: "1", components: [{ type: "x", adapter: "<b>x</b>" }] }, 'components[0].adapter must be an adapter (an object with a kind of "field", "group", "tabs", "grid", "steps" and a template function) or a list of them'],
      ["validators-str", { id: "validators-str", version: "1", validators: ["x"] }, "validators[0] must be an object"],
      ["env-five", { id: "env-five", version: "1", environments: 5 }, "environments must be a list of strings"],
      ["env-number", { id: "env-number", version: "1", environments: [5] }, "environments must be a list of strings"],
      ["deps-null", { id: "deps-null", version: "1", dependencies: [null] }, "dependencies[0] must be an object"],
      ["deps-string", { id: "deps-string", version: "1", dependencies: "x" }, "dependencies must be a list"],
      ["deps-idless", { id: "deps-idless", version: "1", dependencies: [{}] }, "dependencies[0].id must be a non-empty string"],
      ["no-version", { id: "no-version" }, "version must be a string"]
    ];
    registry.register([good, ...malformed.map(([, entry]) => entry as FormPlugin)]);
    expect(registry.plugins()).toEqual([good]);
    expect(notified).toBe(1);
    for (const [id, , problem] of malformed) {
      expect(error).toHaveBeenCalledWith(`[datum] Plugin "${id}" was not registered: ${problem}`);
    }
    // The registry still answers for what it holds.
    expect(registry.components().map((entry) => entry.type)).toEqual(["rating"]);
    expect(() => registry.createPlatform()).not.toThrow();
    expect(withPluginDataSources(undefined, registry.plugins())).toBeUndefined();
  });

  it("takes a plugin whose environments and dependencies are shaped right", () => {
    const registry = createPluginRegistry();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fine = { id: "fine", version: "1", environments: ["browser"], dependencies: [{ id: "survey" }] } as unknown as FormPlugin;
    registry.register(fine);
    expect(registry.plugins()).toEqual([fine]);
    expect(error).not.toHaveBeenCalled();
    // Without an id there is nothing to name, so a stray value is skipped quietly.
    registry.register([{} as unknown as FormPlugin, null as unknown as FormPlugin]);
    expect(error).not.toHaveBeenCalled();
  });

  it("lists the registered components and their palette entries, a later plugin's type replacing an earlier one's", () => {
    const registry = createPluginRegistry();
    const first = ratingDefinition();
    const second = { ...ratingDefinition(), version: "2.0.0", palette: { label: "Stars", group: "Survey" } };
    registry.register([plugin("a", { components: [first] }), plugin("b", { components: [second] })]);
    expect(registry.components()).toEqual([second]);
    expect(registry.paletteEntries()).toEqual([{ type: "rating", label: "Stars", group: "Survey" }]);
    expect(pluginComponents(registry.plugins())).toEqual([second]);
    expect(paletteEntriesOf([first])).toEqual([{ type: "rating", label: "Rating", icon: "★", group: "Survey" }]);
    // What both surfaces edit and draw with: the standard catalogue, then the plugins' types.
    const merged = mergeComponentDefinitions([], registry.components());
    expect(merged.at(-1)).toBe(second);
  });

  it("forwards the builder themes a plugin carries to the page's builder theme registry", () => {
    expect(builderThemes.list().some((theme) => theme.id === "acme-plugin-shell")).toBe(false);
    plugins.register(plugin("acme", { builderThemes: [{ id: "acme-plugin-shell", version: "1.0.0", target: "builder", label: "Acme", tokens: { "db-bg": "#000" } }] }));
    expect(builderThemes.list().some((theme) => theme.id === "acme-plugin-shell")).toBe(true);
  });

  it("puts a plugin's data sources behind the page's, on the set the runtime and the elements read", async () => {
    const page = defineDataSources({ countries: [{ value: "CA", label: "Canada" }] });
    const withSources = plugin("lookups", {
      dataSourceProviders: [{ id: "static-lookups", load: async ({ sourceId }) => ({ items: [{ value: `${sourceId}-1`, label: sourceId }] }) }],
      dataSources: [{ id: "provinces", providerId: "static-lookups", version: "1.0.0" }]
    });
    // Nothing registered: the page's set, untouched.
    expect(withPluginDataSources(page, [plugin("plain")])).toBe(page);
    expect(withPluginDataSources(undefined, [plugin("plain")])).toBeUndefined();

    const composed = withPluginDataSources(page, [withSources, withSources])!;
    expect(composed.ids()).toEqual(["countries", "provinces"]);
    expect(composed.has("provinces")).toBe(true);
    expect(composed.has("regions")).toBe(false);
    expect((await composed.load("countries")).items).toEqual([{ value: "CA", label: "Canada" }]);
    expect((await composed.load("provinces")).items).toEqual([{ value: "provinces-1", label: "provinces" }]);
    await expect(composed.load("regions")).rejects.toThrow(/regions/);
  });
});

describe("createFormRuntime with plugins", () => {
  it("installs a plugin's components, validators, hooks, submission handlers and sandbox modules, and the runtime reports them", async () => {
    const afterSubmit: string[] = [];
    const delivered: string[] = [];
    const survey = plugin("survey", {
      components: [ratingDefinition()],
      validators: [
        {
          id: "experience-required",
          version: "1.0.0",
          validate: (context) =>
            (context.values as Record<string, unknown>).experience === undefined
              ? { errors: [{ code: "experience.required", componentId: "experience", stage: "experience-required", source: "custom" }] }
              : { errors: [] }
        }
      ],
      hooks: { afterSubmit: [({ submissionId }) => void afterSubmit.push(submissionId)] },
      submissionHandlers: [{ id: "deliver", version: "1.0.0", handle: (submission) => void delivered.push(String((submission.submission.values as Record<string, unknown>).experience)) }],
      wasmPlugin: { id: "survey-rules", version: "1.0.0", source: "({ validators: [] })" }
    });
    const registry = createPluginRegistry().register(survey);
    const definition = surveyDefinition();
    const runtime = createFormRuntime(definition, { pluginRegistry: registry });

    const installed = runtime.installedPlugins()!;
    expect(installed.installedPluginIds).toEqual(["survey"]);
    expect(installed.mergedWasmPlugins).toEqual([survey.wasmPlugin]);
    expect(installed.mergedValidators).toEqual(survey.validators);
    // The type is in the registry beside the standard catalogue.
    expect(runtime.pdfRenditionSources().components?.resolve("rating").version).toBe("1.0.0");

    // The validator runs after the field constraints, at validate and at submit.
    await runtime.validate();
    expect(runtime.errors().map((error) => error.code)).toContain("experience.required");
    runtime.setValue("experience", 3);
    const result = await runtime.submit(EMBED_SUBMISSION_MODE, versionContextFor(definition));
    expect(result.accepted).toBe(true);
    expect(afterSubmit).toHaveLength(1);
    expect(delivered).toEqual(["3"]);

    // A runtime without plugins is built as before: no platform, nothing installed.
    expect(createFormRuntime(sampleDefinition(), { pluginRegistry: createPluginRegistry() }).installedPlugins()).toBeUndefined();
  });

  it("counts a plugin given to the page and to the runtime once", () => {
    const survey = plugin("survey", { components: [ratingDefinition()] });
    const registry = createPluginRegistry().register(survey);
    const runtime = createFormRuntime(surveyDefinition(), { pluginRegistry: registry, plugins: [survey] });
    expect(runtime.installedPlugins()!.installedPluginIds).toEqual(["survey"]);
  });
});

describe("<datum-form> with plugins", () => {
  it("installs a plugin's component type given on the element and draws it with its adapter, and again after the page registers one later; a field type without an adapter draws a note and says so", async () => {
    const registry = createPluginRegistry();
    const element = document.createElement("datum-form");
    const readies: DatumFormReadyDetail[] = [];
    element.addEventListener("datum-ready", (event) => readies.push((event as CustomEvent<DatumFormReadyDetail>).detail));
    element.pluginRegistry = registry;
    element.plugins = [plugin("survey", { components: [ratingDefinition()] })];
    element.definition = surveyDefinition();
    document.body.append(element);
    const root = await ready(element);
    await until(() => readies.length === 1);
    expect(readies[0]!.runtime.installedPlugins()!.installedPluginIds).toEqual(["survey"]);
    // The plugin's adapter draws its type, laid over the binding; its css is adopted with the binding's.
    const stars = () => root.querySelectorAll<HTMLButtonElement>('[data-component-id="experience"] .star-rating__star');
    await until(() => stars().length === 4);
    expect(root.querySelector('[data-component-id="experience"] .star-rating > span')?.textContent).toBe("How was it?");
    expect(element.renderer!.live!.unsupported().some((entry) => entry.startsWith("experience:"))).toBe(false);
    expect(element.renderer!.drawnBinding.css).toContain(".star-rating__star.is-on");
    stars()[2]!.click();
    await until(() => root.querySelectorAll('[data-component-id="experience"] .star-rating__star.is-on').length === 3);
    expect(element.values).toMatchObject({ experience: 3 });

    // A late registration on the page: the runtime is rebuilt with it, the way a new
    // componentDefinitions list rebuilds it.
    const late: ComponentDefinition = {
      type: "stamp",
      version: "1.0.0",
      createDefault: () => ({ id: "stamp", type: "stamp", configuration: {} }),
      capabilities: []
    };
    element.definition = {
      ...surveyDefinition(),
      root: { ...surveyDefinition().root, children: { content: [...surveyDefinition().root.children!.content!, { id: "seal", type: "stamp", configuration: {} }] } }
    };
    await until(() => readies.length === 2);
    // A type whose definition brings no adapter: Datum's note naming it, recorded as unsupported.
    const sealNote = () => element.renderer!.shadowRoot!.querySelector('[data-component-id="seal"][data-kind="unknown"] [role="note"]');
    await until(sealNote);
    expect(sealNote()!.textContent).toContain("Unknown component “stamp”");
    expect(element.renderer!.live!.unsupported()).toContain('seal: component "stamp"');
    registry.register(plugin("stamps", { components: [late] }));
    await until(() => readies.length === 3);
    expect(readies[2]!.runtime.installedPlugins()!.installedPluginIds).toEqual(["stamps", "survey"]);
  });

  it("draws the element of a type nothing registered, warns once, and takes up the plugin when the components entry registers it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(plugins.has("datum-acme-components")).toBe(false);
    const element = document.createElement("datum-form");
    const readies: DatumFormReadyDetail[] = [];
    element.addEventListener("datum-ready", (event) => readies.push((event as CustomEvent<DatumFormReadyDetail>).detail));
    element.definition = {
      ...sampleDefinition(),
      root: {
        id: "root",
        type: "form",
        configuration: { title: "Notice" },
        children: {
          content: [
            { id: "note", type: "acme-notice", configuration: { noticeTitle: "Heads up" }, children: { content: [] } },
            { id: "name", type: "text", configuration: { label: "Name" } }
          ]
        }
      }
    };
    document.body.append(element);
    const root = await ready(element);
    // The type's element, empty, in the component's place; the rest of the form as usual.
    await until(() => root.querySelector('[data-container-id="note"][data-kind="acme-notice"]'));
    expect(root.querySelector("#name")).toBeTruthy();
    // The console hears it once per type, not once per repaint.
    const heard = () => warn.mock.calls.filter((call) => String(call[0]).includes('"acme-notice"'));
    expect(heard()).toHaveLength(1);
    expect(String(heard()[0]![0])).toContain('No adapter of this binding draws "acme-notice" (component "note")');
    expect(element.renderer!.live!.unsupported()).toContain('note: component "acme-notice"');
    element.values = { name: "Ada" };
    await until(() => (root.querySelector("#name") as HTMLInputElement).value === "Ada");
    expect(heard()).toHaveLength(1);

    // The components entry registers the plugin on load; the element takes it up: its runtime is rebuilt with it.
    const before = readies.length;
    await import("./fixtures/acme-components-bundle.js");
    expect(plugins.has("datum-acme-components")).toBe(true);
    await until(() => readies.length > before);
    expect(readies.at(-1)!.runtime.installedPlugins()!.installedPluginIds).toContain("datum-acme-components");
    // Now its adapter draws it: the title from its configuration, its children in its body, its css adopted.
    const drawn = () => element.renderer!.shadowRoot!;
    const title = () => drawn().querySelector('[data-container-id="note"] .acme-notice > .acme-notice__title');
    await until(title);
    expect(title()!.textContent).toBe("Heads up");
    expect(element.renderer!.drawnBinding.css).toContain(ACME_NOTICE_CSS[0]);
  });
});

describe("<datum-form-builder> with plugins", () => {
  it("lists a plugin's types on the palette from their definitions, and keeps the tree when the page registers one later", async () => {
    const registry = createPluginRegistry();
    const element = document.createElement("datum-form-builder");
    element.pluginRegistry = registry;
    element.plugins = [acmeComponentsPlugin];
    element.definition = sampleDefinition();
    document.body.append(element);
    await builderReady(element);

    const types = () => element.controller!.componentTypes();
    expect(types().find((entry) => entry.type === ACME_CARD_TYPE)).toEqual({ type: ACME_CARD_TYPE, label: "Card", group: ACME_PALETTE_GROUP });
    expect(types().filter((entry) => entry.group === ACME_PALETTE_GROUP)).toHaveLength(3);
    // The builder's own entry for a type wins over the plugin's, in place.
    element.componentTypes = [{ type: ACME_CARD_TYPE, label: "Our card", group: "Cards" }];
    await until(() => types().find((entry) => entry.type === ACME_CARD_TYPE)?.label === "Our card");
    expect(types().findIndex((entry) => entry.type === ACME_CARD_TYPE)).toBe(types().findIndex((entry) => entry.type === ACME_NOTICE_TYPE) + 1);

    // A late page registration reaches the palette and the catalogue without reseeding: what
    // the author placed stays.
    const before = element.definition.root.children!.content!.length;
    registry.register(plugin("survey", { components: [ratingDefinition()] }));
    await until(() => types().some((entry) => entry.type === "rating"));
    expect(types().find((entry) => entry.type === "rating")).toEqual({ type: "rating", label: "Rating", icon: "★", group: "Survey" });
    expect(element.definition.root.children!.content!).toHaveLength(before);
    expect(() => element.controller!.add("rating")).not.toThrow();
    expect(element.definition.root.children!.content!.at(-1)!.type).toBe("rating");
  });

  it("keeps the undo history, an unapplied draft and the selection when the page registers a plugin later", async () => {
    const registry = createPluginRegistry();
    const element = document.createElement("datum-form-builder");
    element.pluginRegistry = registry;
    element.definition = sampleDefinition();
    document.body.append(element);
    await builderReady(element);

    const controller = element.controller!;
    controller.add("text");
    const added = controller.snapshot().children!.content!.at(-1)!.id;
    controller.select(added);
    controller.setDraftProperty(added, "label", "typed, not applied");
    expect(controller.canUndo()).toBe(true);
    expect(controller.hasPendingChanges(added)).toBe(true);

    registry.register(plugin("survey", { components: [ratingDefinition()] }));
    await until(() => element.controller!.componentTypes().some((entry) => entry.type === "rating"));

    expect(element.controller).toBe(controller);
    expect(controller.canUndo()).toBe(true);
    expect(controller.hasPendingChanges(added)).toBe(true);
    expect(controller.selectedComponentId()).toBe(added);
    // A plugin that adds no component leaves them all as they are too.
    registry.register(plugin("quiet", {}));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(controller.canUndo()).toBe(true);
    expect(controller.hasPendingChanges(added)).toBe(true);
    expect(controller.selectedComponentId()).toBe(added);
  });

  it("draws with the engine's own glyphs unless the page registered a set", () => {
    // The builder bundle registers no icon library (the icons bundle does, on load).
    expect(defaultIconSet()).toBe(BUILTIN_ICONS);
  });

  it("draws a type nothing registered as a node on the canvas, warns once, and says so in the inspector", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const element = document.createElement("datum-form-builder");
    element.pluginRegistry = createPluginRegistry();
    element.definition = {
      ...sampleDefinition(),
      root: {
        id: "root",
        type: "form",
        configuration: { title: "Survey" },
        children: { content: [{ id: "score", type: "rating", configuration: { label: "Score" } }, { id: "name", type: "text", configuration: { label: "Name" } }] }
      }
    };
    document.body.append(element);
    await builderReady(element);
    const canvas = element.builder!.shadowRoot!.querySelector("datum-builder-canvas")!.shadowRoot!;
    await until(() => canvas.querySelector("datum-form-renderer")?.shadowRoot?.querySelector('[data-component-id="score"]'));
    const preview = canvas.querySelector("datum-form-renderer")!.shadowRoot!;
    // The type's note is a node like any other, so it can be selected and deleted.
    expect(preview.querySelector('.db-node[data-component-id="score"] [role="note"]')?.textContent).toContain("Unknown component “rating”");
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('"rating"'))).toHaveLength(1);

    element.controller!.select("score");
    const properties = element.builder!.shadowRoot!.querySelector("datum-builder-properties")!.shadowRoot!;
    await until(() => properties.querySelector("[data-unknown-type]"));
    expect(properties.querySelector("[data-unknown-type]")!.textContent).toContain("Unknown component type “rating”");
    element.controller!.select("name");
    await until(() => !properties.querySelector("[data-unknown-type]"));

    // Registered after the fact, the inspector stops saying it is unknown, and the canvas draws it with its adapter.
    element.controller!.select("score");
    await until(() => properties.querySelector("[data-unknown-type]"));
    element.pluginRegistry.register(plugin("survey", { components: [ratingDefinition()] }));
    await until(() => !properties.querySelector("[data-unknown-type]"));
    const drawn = () => canvas.querySelector("datum-form-renderer")?.shadowRoot;
    await until(() => drawn()?.querySelectorAll('.db-node[data-component-id="score"] .star-rating__star').length === 5);
    expect(drawn()?.querySelector('.db-node[data-component-id="score"] [role="note"]')).toBeNull();
  });
});

describe("unresolved theme ids are reported once", () => {
  const collect = (element: HTMLElement): string[] => {
    const errors: string[] = [];
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<DatumErrorDetail>).detail.message));
    return errors;
  };
  const theme = (id: string) => ({ id, version: "1.0.0", target: "builder" as const, label: id, tokens: { "db-bg": "#fff" } });

  it("on the builder: the shell theme once across registrations, then resolved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const registry = createThemeRegistry();
    const element = document.createElement("datum-form-builder");
    const errors = collect(element);
    element.themes = registry;
    element.theme = "acme-shell";
    element.definition = sampleDefinition();
    document.body.append(element);
    await builderReady(element);
    await until(() => errors.length === 1);
    expect(errors[0]).toContain('Unknown builder theme "acme-shell"');
    registry.builder.register(theme("other"));
    registry.builder.register(theme("another"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(errors).toHaveLength(1);
    registry.builder.register({ id: "acme-shell", version: "1.0.0", target: "builder", label: "Acme", tokens: { "db-bg": "#000" } });
    await until(() => (element.builder?.theme as { id?: string } | undefined)?.id === "acme-shell");
    expect(errors).toHaveLength(1);
  });
});

describe("plugin platform built by the elements", () => {
  const component = (type: string) => ({ type, version: "1.0.0", createDefault: () => ({ id: type, type, configuration: {} }), capabilities: [] }) as never;

  it("refuses a plugin whose engineRange the engine does not satisfy, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const plugin: FormPlugin = { id: "future", version: "1.0.0", engineRange: "^99.0.0" };
    const result = createPluginPlatform([plugin]).installAndInitialize({ environment: "browser" });
    expect(result.incompatiblePluginIds).toEqual(["future"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"future"'));
    warn.mockRestore();
  });

  it("a plugin whose install fails part-way leaves nothing behind", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const a: FormPlugin = { id: "a", version: "1.0.0", components: [component("shared")] };
    const b: FormPlugin = { id: "b", version: "1.0.0", components: [component("b-own"), component("shared")] };
    const platform = createPluginPlatform([a, b]);
    const result = platform.installAndInitialize({ environment: "browser" });
    expect(result.failedPluginIds).toContain("b");
    const registries = (platform as unknown as { registries: { components: { list(type: string): unknown[] } } }).registries;
    expect(registries.components.list("b-own")).toHaveLength(0);
    warn.mockRestore();
  });
});
