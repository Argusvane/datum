// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FormDefinition } from "../form-engine/core/schema/types.js";
import type { FormEvent } from "../form-engine/core/events/event-bus.js";
import { FormEventType } from "../form-engine/core/events/event-types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import type { DataSourceSet } from "../form-engine/core/schema/contracts.js";
import { DEFAULT_FORM_TEXTS, createFormTextResolver } from "../form-engine/core/localization/form-texts.js";
import { formulaEditorLoaded, loadFormulaEditor } from "../form-engine/builder/formula/formula-editor-loader.js";
import {
  defineDatumFormRendererElement,
  DATUM_FORM_RENDERER_TAG,
  isCaretControl,
  type DatumFormRendererElement
} from "../form-engine/render/web-component/form-renderer-element.js";

/*
 * The seams the agent tools read on <datum-form-renderer>: `painted()` settles once
 * every change so far is drawn, `settleInput()` commits what the person is still typing before
 * the body goes inert, `quietNextPageFocus()` keeps focus where the person left it across an
 * agent's page move, and `isCaretControl` is the one test of "a control typed into with a caret",
 * shared rather than copied. Asserted on the DOM contract (`data-component-id` on the
 * field's wrapper), state hooks, accessible roles, values and events.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

function form(label: string): FormDefinition {
  return {
    id: "plain",
    version: "1",
    schemaVersion: "1",
    root: {
      id: "root",
      type: "form",
      configuration: {},
      children: { content: [{ id: "name", type: "text", configuration: { label } }] }
    }
  } as FormDefinition;
}

function runtimeFor(definition: FormDefinition): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
}

/** The control inside the field wrapper the DOM contract names by component id. */
function control<E extends HTMLElement = HTMLInputElement>(root: ShadowRoot, componentId: string, selector = "input"): E | null {
  return root.querySelector<E>(`[data-component-id="${componentId}"] ${selector}`);
}

function mount(definition: FormDefinition) {
  defineDatumFormRendererElement();
  const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
  const runtime = runtimeFor(definition);
  element.runtime = runtime;
  document.body.append(element);
  return { element, runtime, root: element.shadowRoot! };
}

/** Which of two promises settles first: the paint, or a macrotask that starts after it. */
async function first(painted: Promise<void>): Promise<"painted" | "timer"> {
  return Promise.race([painted.then(() => "painted" as const), new Promise<"timer">((resolve) => setTimeout(() => resolve("timer"), 0))]);
}

/** The events of one type the runtime publishes from now on. */
function record(runtime: FormRuntime, type: string): FormEvent[] {
  const seen: FormEvent[] = [];
  runtime.events().subscribe(type, (event) => {
    seen.push(event);
  });
  return seen;
}

describe("painted(): every change so far drawn", () => {
  it("resolves once the first draw has landed, and at once while nothing is being drawn", async () => {
    const { element, root } = mount(form("Your name"));
    await element.painted();
    expect(root.querySelector("form")).not.toBeNull();
    expect(control(root, "name")).not.toBeNull();

    // Idle: the promise is already settled, so it wins against a macrotask queued after it.
    expect(await first(element.painted())).toBe("painted");
  });

  it("resolves after a definition change settles, with the new markup drawn", async () => {
    const { element, root } = mount(form("Your name"));
    await element.painted();
    expect(root.textContent).toContain("Your name");

    element.runtime = runtimeFor(form("Your city"));
    await element.painted();
    expect(root.textContent).toContain("Your city");
    expect(root.textContent).not.toContain("Your name");
    expect(control(root, "name")).not.toBeNull();
  });

  it("follows a build overtaken under a slow data source to the one that draws", async () => {
    // A select fed by a source that answers only when the test says so: each build parks one call.
    const pending: Array<(value: unknown) => void> = [];
    const sources = {
      has: () => true,
      ids: () => ["cities"],
      load: () => new Promise((resolve) => pending.push(resolve))
    } as unknown as DataSourceSet;
    const withSelect = (label: string): FormDefinition => {
      const definition = form(label);
      definition.root.children!.content!.push({ id: "city", type: "select", configuration: { label: "City", data: { sourceId: "cities" } } } as never);
      return definition;
    };
    const answer = (resolvers: Array<(value: unknown) => void>) => resolvers.forEach((resolve) => resolve({ items: [{ value: "a", label: "A" }] }));
    const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

    defineDatumFormRendererElement();
    const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
    element.dataSources = sources;
    element.runtime = runtimeFor(withSelect("Your name"));
    document.body.append(element);
    await tick();
    answer(pending.splice(0));
    await element.painted();
    const root = element.shadowRoot!;
    expect(root.textContent).toContain("Your name");

    // The agent's write: a rebuild whose source call is parked; the agent takes the promise now.
    const next = runtimeFor(withSelect("Your city"));
    element.runtime = next;
    const awaited = element.painted();
    let settled = false;
    void awaited.then(() => {
      settled = true;
    });
    await tick();
    const first = pending.splice(0);
    expect(first).toHaveLength(1);

    // The person's keystroke: a second rebuild supersedes the first, which will paint nothing.
    next.setValue("name", "Ada");
    await tick();
    const second = pending.splice(0);
    expect(second.length).toBeGreaterThan(0);
    answer(first);
    await tick();
    const city = () => root.querySelector<HTMLElement>('[data-component-id="city"]');
    // Only the provisional draw is up (the choices still loading), so the promise must not have settled.
    expect(city()?.getAttribute("data-source")).toBe("loading");
    expect(city()?.getAttribute("aria-busy")).toBe("true");
    expect(settled).toBe(false);

    answer(second);
    await awaited;
    expect(city()?.hasAttribute("data-source")).toBe(false);
    expect(city()?.getAttribute("aria-busy")).toBeNull();
    expect(root.querySelector("option[value=\"a\"]")).not.toBeNull();
    expect(control(root, "name")?.value).toBe("Ada");
  });

  it("settles when the form cannot be built (a host runtime whose errors() throws), and the next runtime draws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    defineDatumFormRendererElement();
    const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
    const problems: string[] = [];
    element.addEventListener("datum-binding-error", (event) => problems.push((event as CustomEvent<{ hook: string }>).detail.hook));
    const failures: string[] = [];
    element.addEventListener("datum-error", (event) => failures.push((event as CustomEvent<{ message: string }>).detail.message));
    const runtime = runtimeFor(form("Your name"));
    (runtime as unknown as { errors: () => unknown }).errors = () => {
      throw new Error("boom");
    };
    document.body.append(element);
    // The setter never throws: the form is mounted after it, and its build fails there.
    expect(() => {
      element.runtime = runtime;
    }).not.toThrow();
    await expect(element.painted()).resolves.toBeUndefined();
    expect(await first(element.painted())).toBe("painted");
    // An alert stands in the form's place, and the host hears why on both channels.
    expect(element.shadowRoot!.querySelector('[role="alert"]')).not.toBeNull();
    expect(element.shadowRoot!.querySelector("form")).toBeNull();
    expect(problems).toContain("render");
    expect(failures).toEqual(["boom"]);

    // Another runtime: the form is mounted again and drawn.
    element.runtime = runtimeFor(form("Your name"));
    await element.painted();
    expect(control(element.shadowRoot!, "name")).not.toBeNull();
    expect(element.shadowRoot!.querySelector('[role="alert"]')).toBeNull();
    consoleError.mockRestore();
  });
});

describe("the agent texts: every counted one is a pair .plural reads on its own", () => {
  const counted = Object.keys(DEFAULT_FORM_TEXTS).filter((key) => key.startsWith("agent") && DEFAULT_FORM_TEXTS[key as keyof typeof DEFAULT_FORM_TEXTS].includes("{{count}}"));

  it("names the singular {base}One beside {base}, in both languages, so no caller passes fallback keys", () => {
    expect(counted.length).toBeGreaterThan(0);
    const params = { count: 1, label: "Pets" };
    for (const key of counted) {
      const base = key.endsWith("One") ? key.slice(0, -3) : key;
      expect(Object.keys(DEFAULT_FORM_TEXTS), base).toContain(base);
      expect(Object.keys(DEFAULT_FORM_TEXTS), `${base}One`).toContain(`${base}One`);
      for (const locale of ["en", "fr-CA"]) {
        const texts = createFormTextResolver(locale);
        const one = texts.plural(base, 1, params);
        const many = texts.plural(base, 3, { ...params, count: 3 });
        // A key nobody worded comes back as the key itself; neither count may read that way.
        expect(one, `${base} ×1 ${locale}`).not.toMatch(/^agent\w+$/);
        expect(many, `${base} ×3 ${locale}`).not.toMatch(/^agent\w+$/);
        // The singular and the plural are worded apart: compared with the count taken out, so a
        // {base}One mistakenly given the plural sentence cannot hide behind "1" differing from "3".
        expect(one.replace(/\b1\b/, "#"), `${base} pair ${locale}`).not.toBe(many.replace(/\b3\b/, "#"));
      }
    }
    expect(createFormTextResolver("en").plural("agentRowsAdded", 1, params)).toBe("An assistant added 1 row to Pets");
    // Another language is the form's `texts` translation of each of the pair (the engine words only English).
    const translations = {
      fr: { texts: { form: { agentRowsAdded: { text: "Un assistant a ajouté {{count}} lignes à {{label}}", source: "x" }, agentRowsAddedOne: { text: "Un assistant a ajouté {{count}} ligne à {{label}}", source: "x" } } } }
    };
    const french = createFormTextResolver("fr", undefined, undefined, undefined, { translations });
    expect(french.plural("agentRowsAdded", 2, { count: 2, label: "Animaux" })).toBe("Un assistant a ajouté 2 lignes à Animaux");
    expect(french.plural("agentRowsAdded", 1, { count: 1, label: "Animaux" })).toBe("Un assistant a ajouté 1 ligne à Animaux");
  });
});

describe("settleInput(): the person's pending keystroke", () => {
  it("commits the interim value typed into a text input, once, and is then a no-op", async () => {
    const { element, runtime, root } = mount(form("Your name"));
    await element.painted();
    const changed = record(runtime, FormEventType.COMPONENT_CHANGED);
    const committed = record(runtime, FormEventType.COMPONENT_COMMITTED);

    // A keystroke: `input` without `change` or `focusout`, so the value stays interim.
    const input = control(root, "name")!;
    input.value = "Ada";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(changed).toHaveLength(1);
    expect(changed[0]!.data).toEqual({ value: "Ada", interim: true });
    expect(runtime.formValues().name).toBe("Ada");
    expect(committed).toHaveLength(0);

    element.settleInput();
    expect(committed).toHaveLength(1);
    expect(committed[0]!.data).toEqual({ value: "Ada" });
    expect(runtime.formValues().name).toBe("Ada");
    // Settling writes nothing: the one change stays the keystroke's.
    expect(changed).toHaveLength(1);

    // Nothing left pending: a second call commits nothing twice.
    element.settleInput();
    expect(committed).toHaveLength(1);
    expect(changed).toHaveLength(1);
  });

  it("does nothing when nothing was typed", async () => {
    const { element, runtime } = mount(form("Your name"));
    await element.painted();
    const changed = record(runtime, FormEventType.COMPONENT_CHANGED);
    const committed = record(runtime, FormEventType.COMPONENT_COMMITTED);
    element.settleInput();
    expect(changed).toHaveLength(0);
    expect(committed).toHaveLength(0);
  });
});

describe("isCaretControl: the control typed into with a caret", () => {
  const input = (type?: string): HTMLInputElement => {
    const control = document.createElement("input");
    if (type !== undefined) {
      control.type = type;
    }
    return control;
  };

  it("is true for a textarea and for the caret input types, a bare input included", () => {
    expect(isCaretControl(document.createElement("textarea"))).toBe(true);
    // A bare <input> is the empty type, which the browser reads as text.
    expect(isCaretControl(input())).toBe(true);
    for (const type of ["text", "search", "email", "tel", "url", "password", "number"]) {
      expect(isCaretControl(input(type)), type).toBe(true);
    }
  });

  it("is false for a select and for the inputs that report a finished choice on input", () => {
    expect(isCaretControl(document.createElement("select"))).toBe(false);
    for (const type of ["checkbox", "radio", "date", "range"]) {
      expect(isCaretControl(input(type)), type).toBe(false);
    }
    expect(isCaretControl(document.createElement("div"))).toBe(false);
  });
});

describe("formulaEditorLoaded(): the editor module once it is on the page", () => {
  it("is undefined before a load and the loaded module after, so check_form can lint without fetching the chunk", async () => {
    // Fresh module state: vitest isolates each test file, so nothing has loaded the editor here yet.
    expect(formulaEditorLoaded()).toBeUndefined();
    const module = await loadFormulaEditor();
    expect(formulaEditorLoaded()).toBe(module);
    expect(formulaEditorLoaded()).toBe(await loadFormulaEditor());
  });
});

describe("quietNextPageFocus(): an agent's journey page move", () => {
  function journeyForm(): FormDefinition {
    return {
      id: "flow",
      version: "1",
      schemaVersion: "1",
      root: {
        id: "root",
        type: "form",
        configuration: {},
        children: {
          content: [
            { id: "first", type: "text", configuration: { label: "First answer" } },
            { id: "second", type: "text", configuration: { label: "Second answer" } }
          ]
        }
      },
      journey: {
        opensAs: "journey",
        defaultJourneyId: "flow",
        journeys: [
          {
            id: "flow",
            pages: [
              { id: "one", title: "Page one", components: ["first"] },
              { id: "two", title: "Page two", components: ["second"] }
            ]
          }
        ]
      }
    } as unknown as FormDefinition;
  }

  /** The page's heading: the one heading a journey page draws here (the form has no title). */
  const heading = (root: ShadowRoot): HTMLElement | null => root.querySelector<HTMLElement>("h1, h2, h3, h4, h5, h6");

  /** A page's own button, by its accessible name. */
  const button = (root: ShadowRoot, name: string): HTMLButtonElement | undefined =>
    Array.from(root.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === name);

  /** The person's chat box outside the form, holding focus. */
  function chatBox(): HTMLInputElement {
    const chat = document.createElement("input");
    document.body.append(chat);
    chat.focus();
    return chat;
  }

  /** Counts the form's draws and the scrolls a page change asks for from now on. */
  function watch(element: DatumFormRendererElement) {
    const scroll = vi.fn();
    (HTMLElement.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scroll;
    let from = element.live!.draws();
    const draws = {
      count: () => element.live!.draws() - from,
      reset: () => {
        from = element.live!.draws();
      }
    };
    return { draws, scroll };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    delete (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("draws the new page and moves no focus; the quiet is one-shot, so the next page change focuses the heading", async () => {
    const { element, runtime, root } = mount(journeyForm());
    await element.painted();
    expect(heading(root)?.textContent).toContain("Page one");
    runtime.setValues({ first: "A" });
    await element.painted();
    const chat = chatBox();
    const { draws, scroll } = watch(element);

    element.quietNextPageFocus();
    expect((await runtime.nextPage!()).ok).toBe(true);
    await element.painted();
    expect(heading(root)?.textContent).toContain("Page two");
    expect(document.activeElement).toBe(chat);
    expect(root.activeElement).toBeNull();
    expect(scroll).not.toHaveBeenCalled();
    const quietDraws = draws.count();
    expect(quietDraws).toBeGreaterThan(0);

    // The PAGE_CHANGED above used the quiet up: a page change nobody quieted (here the runtime
    // called directly, not through the page's Back) focuses the heading, in as many draws.
    draws.reset();
    expect((await runtime.previousPage!()).ok).toBe(true);
    await element.painted();
    expect(heading(root)?.textContent).toContain("Page one");
    expect(root.activeElement).toBe(heading(root));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(draws.count()).toBe(quietDraws);
  });

  it("a quiet no page change used is ended by the person's own Continue", async () => {
    const { element, runtime, root } = mount(journeyForm());
    await element.painted();
    const chat = chatBox();
    const { scroll } = watch(element);

    // Refused (a page past the frontier): no PAGE_CHANGED, so the quiet is still set...
    element.quietNextPageFocus();
    expect((await runtime.goToPage!("two")).ok).toBe(false);
    await element.painted();
    expect(heading(root)?.textContent).toContain("Page one");
    expect(document.activeElement).toBe(chat);

    // ...until the person presses Continue themselves: their move focuses the next heading.
    runtime.setValues({ first: "A" });
    await element.painted();
    button(root, "Continue")!.click();
    await vi.waitFor(() => expect(heading(root)?.textContent).toContain("Page two"));
    await element.painted();
    expect(root.activeElement).toBe(heading(root));
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("the release handed back ends a quiet no page change used, so a later runtime move focuses the heading", async () => {
    const { element, runtime, root } = mount(journeyForm());
    await element.painted();
    const chat = chatBox();
    const { scroll } = watch(element);

    // An agent's move refused (a page past the frontier): no PAGE_CHANGED used the quiet...
    const release = element.quietNextPageFocus();
    expect((await runtime.goToPage!("two")).ok).toBe(false);
    // ...and the caller releases it once that call settled.
    release();
    await element.painted();
    expect(document.activeElement).toBe(chat);

    // A page change the host asks of the runtime directly (its own Next button, a popstate).
    runtime.setValues({ first: "A" });
    expect((await runtime.nextPage!()).ok).toBe(true);
    await element.painted();
    expect(heading(root)?.textContent).toContain("Page two");
    expect(root.activeElement).toBe(heading(root));
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("an older call's release leaves a newer quiet alone", async () => {
    const { element, runtime, root } = mount(journeyForm());
    await element.painted();
    runtime.setValues({ first: "A" });
    await element.painted();
    const chat = chatBox();
    const { scroll } = watch(element);

    const older = element.quietNextPageFocus();
    const newer = element.quietNextPageFocus();
    older();
    expect((await runtime.nextPage!()).ok).toBe(true);
    newer();
    await element.painted();
    expect(heading(root)?.textContent).toContain("Page two");
    expect(document.activeElement).toBe(chat);
    expect(scroll).not.toHaveBeenCalled();
  });

  it("quiets nothing while focus is inside the form: the control on the page being left goes, and the new heading takes focus", async () => {
    const { element, runtime, root } = mount(journeyForm());
    await element.painted();
    runtime.setValues({ first: "A" });
    await element.painted();
    const input = root.querySelector<HTMLInputElement>("input")!;
    input.focus();
    expect(root.activeElement).toBe(input);
    const { scroll } = watch(element);

    const release = element.quietNextPageFocus();
    expect((await runtime.nextPage!()).ok).toBe(true);
    release();
    await element.painted();
    expect(heading(root)?.textContent).toContain("Page two");
    expect(root.activeElement).toBe(heading(root));
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("drops a page focus already queued for a page not yet painted", async () => {
    const { element, runtime, root } = mount(journeyForm());
    await element.painted();
    runtime.setValues({ first: "A" });
    await element.painted();
    const chat = chatBox();
    const { scroll } = watch(element);
    // Heard after the page module's own PAGE_CHANGED listener, before the draw of the new page.
    const off = runtime.events().subscribe(FormEventType.PAGE_CHANGED, () => element.quietNextPageFocus());
    expect((await runtime.nextPage!()).ok).toBe(true);
    off();
    await element.painted();
    expect(heading(root)?.textContent).toContain("Page two");
    expect(document.activeElement).toBe(chat);
    expect(scroll).not.toHaveBeenCalled();
  });
});
