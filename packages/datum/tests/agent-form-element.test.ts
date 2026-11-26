import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The renderer catalogue's element host in jsdom:
 * what `<datum-form>` shows and refuses around the agent's writes — the polite
 * live region in the form's language, the timed highlight after the paint, the focused-field
 * rule through `document.hasFocus()`, `inert` and the banner with Stop during a session, Stop
 * restoring values and offering Allow again, `form-not-ready { state: "loading" }` from the
 * element's build state while a `src` swap rebuilds, the memo's data sources wrapped with the
 * renderer's timeout, and the agent's submit reaching `datum-submit` as `trigger: "agent"` with
 * nothing of it reaching the runtime. jsdom lays nothing out: attributes and classes only.
 */
const gate = vi.hoisted(() => ({ hold: false, release: undefined as (() => void) | undefined }));
vi.mock("../src/journey-engine-loader.js", async (original) => {
  const real = await original<typeof import("../src/journey-engine-loader.js")>();
  return {
    ...real,
    loadedJourneyEngine: () => (gate.hold ? undefined : real.loadedJourneyEngine()),
    loadJourneyEngine: () =>
      gate.hold
        ? new Promise<Awaited<ReturnType<typeof real.loadJourneyEngine>>>((resolve) => {
            gate.release = () => resolve(real.loadJourneyEngine());
          })
        : real.loadJourneyEngine()
  };
});

import "../src/form.js";
import type { DatumFormElement, DatumFormSubmitDetail } from "../src/form.js";
import type { AgentToolResult } from "@argusvane/datum-engine/agent";
import type { FormDefinition } from "@argusvane/datum-engine";

import { AGENT_HIGHLIGHT_RULE } from "../src/agent-host.js";
import type { AgentProvenance, DatumPdfDetail, FormDraft, FormPlugin } from "@argusvane/datum-engine";
import { sampleDefinition, until, withEngineWords } from "./helpers.js";

type Row = Record<string, unknown>;

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(() => {
  unhandled.length = 0;
  gate.hold = false;
  gate.release = undefined;
  process.on("unhandledRejection", onUnhandled);
});

afterEach(async () => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  await settle();
  process.off("unhandledRejection", onUnhandled);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(unhandled).toEqual([]);
});

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

/** The sample form without its data-source select, which reports a missing source on its own (it has none here). */
function plainDefinition(): FormDefinition {
  const sample = sampleDefinition();
  const content = (sample.root.children?.content ?? []).filter((node) => node.id !== "country");
  return { ...sample, root: { ...sample.root, children: { content } } };
}

/** The plain form with the person's own Submit and PDF buttons (`data-button-action`). */
function buttonsDefinition(): FormDefinition {
  const plain = plainDefinition();
  const content = [
    ...(plain.root.children?.content ?? []),
    { id: "sendButton", type: "button", configuration: { label: "Send", action: "submit" } },
    { id: "pdfButton", type: "button", configuration: { label: "Get PDF", action: "pdf" } }
  ];
  return { ...plain, root: { ...plain.root, children: { content } } } as FormDefinition;
}

function journeyDefinition(): FormDefinition {
  return {
    id: "flow-form",
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
          validation: { continue: "page" },
          pages: [
            { id: "one", title: "Page one", components: ["first"] },
            { id: "two", title: "Page two", components: ["second"] }
          ]
        }
      ]
    }
  } as unknown as FormDefinition;
}

interface Mounted {
  element: DatumFormElement;
  errors: Array<{ message: string; cause?: unknown }>;
  actions: Row[];
  shadow(): ShadowRoot;
  ok(name: string, input?: unknown): Promise<Row>;
  refused(name: string, input?: unknown): Promise<Row>;
  execute(name: string, input?: unknown): Promise<AgentToolResult>;
}

async function mount(attributes: Record<string, string> = {}, setup?: (element: DatumFormElement) => void, definition: FormDefinition = plainDefinition()): Promise<Mounted> {
  const element = document.createElement("datum-form") as DatumFormElement;
  const errors: Mounted["errors"] = [];
  const actions: Row[] = [];
  element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent).detail));
  element.addEventListener("datum-agent-action", (event) => actions.push((event as CustomEvent<Row>).detail));
  element.setAttribute("features", "all agent");
  element.setAttribute("agent-access", "always");
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  setup?.(element);
  element.definition = definition;
  document.body.append(element);
  await element.ready;
  await until(() => element.renderer?.shadowRoot?.querySelector("form"));
  const execute = (name: string, input: unknown = {}): Promise<AgentToolResult> => element.executeAgentTool(name, input);
  return {
    element,
    errors,
    actions,
    shadow: () => element.renderer!.shadowRoot!,
    execute,
    async ok(name, input = {}) {
      const result = await execute(name, input);
      if (!result.ok) {
        throw new Error(`${name} refused: ${result.code}: ${result.message} ${JSON.stringify(result.details)}`);
      }
      return result as unknown as Row;
    },
    async refused(name, input = {}) {
      const result = await execute(name, input);
      if (result.ok) {
        throw new Error(`${name} was not refused: ${JSON.stringify(result).slice(0, 300)}`);
      }
      return result as unknown as Row;
    }
  };
}

const live = (element: DatumFormElement): HTMLElement | null => element.shadowRoot!.querySelector<HTMLElement>("[data-agent-live]");
const banner = (element: DatumFormElement): HTMLElement | null => element.shadowRoot!.querySelector<HTMLElement>("[data-agent-banner]");
const bannerText = (element: DatumFormElement): string | undefined => banner(element)?.querySelector("[data-agent-banner-text]")?.textContent ?? undefined;
/** The box the DOM contract puts on a field (`data-component-id`), which carries the agent's highlight. */
const fullNameBox = (mounted: Mounted): HTMLElement => mounted.shadow().querySelector<HTMLElement>('[data-component-id="fullName"]')!;
const fullNameInput = (mounted: Mounted): HTMLInputElement => mounted.shadow().querySelector<HTMLInputElement>('[data-component-id="fullName"] input')!;
const refusedPaths = (result: Row): Array<{ path: string; code: string }> => ((result.refused as Row[] | undefined) ?? []).map((entry) => ({ path: entry.path as string, code: entry.code as string }));
const writtenPaths = (result: Row): string[] => ((result.written as Row[] | undefined) ?? []).map((entry) => entry.path as string);

describe("announcements and the highlight", () => {
  it("puts the empty live region in place when the tools attach, before any announcement", async () => {
    const mounted = await mount();
    await until(() => live(mounted.element) !== null);
    expect(live(mounted.element)!.textContent).toBe("");
    expect(live(mounted.element)!.getAttribute("aria-live")).toBe("polite");
  });

  it("a second write to the same field inside the window keeps its own 1 500 ms", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const mounted = await mount();
    await mounted.ok("set_answers", { answers: { fullName: "Ada" } });
    await until(() => fullNameBox(mounted).hasAttribute("data-agent-touched"));
    vi.advanceTimersByTime(1_000);
    await mounted.ok("set_answers", { answers: { fullName: "Grace" } });
    await until(() => fullNameInput(mounted).value === "Grace" && fullNameBox(mounted).hasAttribute("data-agent-touched"));
    // Past the first write's window: the second write's outline is still up.
    vi.advanceTimersByTime(600);
    expect(fullNameBox(mounted).hasAttribute("data-agent-touched")).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(fullNameBox(mounted).hasAttribute("data-agent-touched")).toBe(false);
  });

  it("says what was filled in the polite live region, in English and then in French after set_locale", async () => {
    // The French is the form's `texts` translation (the engine words only English).
    const mounted = await mount({}, undefined, withEngineWords(plainDefinition(), "fr", { texts: { agentFilled: "Un assistant a rempli {{count}} champs", agentFilledOne: "Un assistant a rempli {{count}} champ" } }));
    await mounted.ok("set_answers", { answers: { fullName: "Ada" } });
    expect(live(mounted.element)?.getAttribute("role")).toBe("status");
    expect(live(mounted.element)?.getAttribute("aria-live")).toBe("polite");
    expect(live(mounted.element)?.textContent).toBe("An assistant filled 1 field");
    // Appended once to <datum-form>'s own shadow root, never inside the renderer's.
    expect(mounted.element.shadowRoot!.querySelectorAll("[data-agent-live]")).toHaveLength(1);
    expect(mounted.shadow().querySelector("[data-agent-live]")).toBeNull();

    await mounted.ok("set_locale", { locale: "fr-CA" });
    await mounted.ok("set_answers", { answers: { fullName: "Grace", subscribe: true } });
    expect(live(mounted.element)?.textContent).toBe("Un assistant a rempli 2 champs");
    expect(mounted.element.shadowRoot!.querySelectorAll("[data-agent-live]")).toHaveLength(1);
  });

  it("outlines the written field after the paint with data-agent-touched and clears it after 1 500 ms", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const mounted = await mount();
    const result = await mounted.ok("set_answers", { answers: { fullName: "Ada" } });
    expect(writtenPaths(result)).toEqual(["fullName"]);
    expect(mounted.element.renderer!.extraStyles).toContain(AGENT_HIGHLIGHT_RULE);
    expect(mounted.element.renderer!.extraStyles.split(AGENT_HIGHLIGHT_RULE)).toHaveLength(2);
    await until(() => fullNameBox(mounted).hasAttribute("data-agent-touched"));
    expect(fullNameInput(mounted).value).toBe("Ada");
    vi.advanceTimersByTime(1_499);
    expect(fullNameBox(mounted).hasAttribute("data-agent-touched")).toBe(true);
    vi.advanceTimersByTime(2);
    expect(fullNameBox(mounted).hasAttribute("data-agent-touched")).toBe(false);
    // A second write appends the rule no second time.
    await mounted.ok("set_answers", { answers: { subscribe: true } });
    expect(mounted.element.renderer!.extraStyles.split(AGENT_HIGHLIGHT_RULE)).toHaveLength(2);
  });
});

describe("the focused-field rule", () => {
  it("refuses the field the person is typing in with field-in-use while the document has focus, writes the rest, and moves no focus", async () => {
    const mounted = await mount();
    const input = fullNameInput(mounted);
    input.focus();
    expect(mounted.shadow().activeElement).toBe(input);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const result = await mounted.ok("set_answers", { answers: { fullName: "Ada", subscribe: true } });
    expect(refusedPaths(result)).toEqual([{ path: "fullName", code: "field-in-use" }]);
    expect(writtenPaths(result)).toEqual(["subscribe"]);
    expect(document.activeElement).toBe(mounted.element);
    expect(mounted.shadow().activeElement).toBe(fullNameInput(mounted));
    expect(mounted.element.runtime!.formValues().fullName).toBeUndefined();
  });

  it("names the row's own path for a field the person is typing in inside a data grid (focusedValuePath = the row path)", async () => {
    const definition = {
      id: "grid-form",
      version: "1.0.0",
      schemaVersion: "1",
      localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }] },
      root: {
        id: "root",
        type: "form",
        configuration: {},
        children: {
          content: [
            {
              id: "items",
              type: "dataGrid",
              configuration: { label: "Items" },
              collection: { collectionPath: "items" },
              children: { content: [{ id: "sku", type: "text", configuration: { label: "SKU" } }] }
            }
          ]
        }
      }
    } as unknown as FormDefinition;
    const mounted = await mount({}, undefined, definition);
    mounted.element.runtime!.setValues({ items: [{ sku: "a" }, { sku: "b" }] });
    await mounted.element.renderer!.painted();
    // The DOM contract: one box per row field, each under its own row's value path.
    await until(() => mounted.shadow().querySelectorAll('[data-component-id="sku"]').length === 2);
    const boxes = [...mounted.shadow().querySelectorAll<HTMLElement>('[data-component-id="sku"]')];
    expect(boxes.map((box) => box.dataset.valuePath)).toEqual(["items[0].sku", "items[1].sku"]);
    const second = boxes[1]!.querySelector<HTMLInputElement>("input")!;
    second.focus();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const result = await mounted.ok("set_answers", { answers: { "items[0].sku": "first", "items[1].sku": "second" } });
    expect(refusedPaths(result)).toEqual([{ path: "items[1].sku", code: "field-in-use" }]);
    expect(writtenPaths(result)).toEqual(["items[0].sku"]);
    await mounted.element.renderer!.painted();
    const drawn = [...mounted.shadow().querySelectorAll<HTMLInputElement>('[data-component-id="sku"] input')].map((input) => input.value);
    expect(drawn).toEqual(["first", "b"]);
    expect(mounted.shadow().activeElement).toBe(second);
  });

  it("refuses with field-in-use when the form sits inside another component's shadow root", async () => {
    const outer = document.createElement("div");
    document.body.append(outer);
    const outerRoot = outer.attachShadow({ mode: "open" });
    const element = document.createElement("datum-form") as DatumFormElement;
    element.setAttribute("features", "all agent");
    element.setAttribute("agent-access", "always");
    element.definition = plainDefinition();
    outerRoot.append(element);
    await element.ready;
    await until(() => element.renderer?.shadowRoot?.querySelector('[data-component-id="fullName"] input'));
    const input = element.renderer!.shadowRoot!.querySelector<HTMLInputElement>('[data-component-id="fullName"] input')!;
    input.focus();
    expect(document.activeElement).toBe(outer);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const result = await element.executeAgentTool("set_answers", { answers: { fullName: "Ada", subscribe: true } });
    expect(result.ok).toBe(true);
    expect(refusedPaths(result as unknown as Row)).toEqual([{ path: "fullName", code: "field-in-use" }]);
    expect(element.runtime!.formValues().fullName).toBeUndefined();
  });

  it("writes the focused field when the document does not have focus (the person is in the browser's side panel)", async () => {
    const mounted = await mount();
    fullNameInput(mounted).focus();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const result = await mounted.ok("set_answers", { answers: { fullName: "Ada" } });
    expect(refusedPaths(result)).toEqual([]);
    expect(writtenPaths(result)).toEqual(["fullName"]);
    expect(mounted.element.runtime!.formValues().fullName).toBe("Ada");
    // A focused non-caret control never blocks either.
    const subscribe = mounted.shadow().querySelector<HTMLInputElement>('[data-component-id="subscribe"] input')!;
    subscribe.focus();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const picked = await mounted.ok("set_answers", { answers: { subscribe: true } });
    expect(writtenPaths(picked)).toEqual(["subscribe"]);
  });
});

describe("sessions on the element", () => {
  it("begin_session makes the renderer inert, shows the banner with Stop and moves focus to it; end_session lifts it and shows the summary", async () => {
    const mounted = await mount();
    const input = fullNameInput(mounted);
    input.focus();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const begun = await mounted.ok("begin_session", { purpose: "Filling your claim" });
    expect(begun).toMatchObject({ locked: true, pausedTyping: true });
    expect(mounted.element.renderer!.hasAttribute("inert")).toBe(true);
    const region = banner(mounted.element)!;
    expect(region.hidden).toBe(false);
    expect(region.getAttribute("role")).toBe("region");
    expect(region.getAttribute("aria-label")).toBe("Assistant");
    expect(bannerText(mounted.element)).toBe("An assistant is working on this form: Filling your claim");
    const stop = region.querySelector<HTMLButtonElement>("[data-agent-stop]")!;
    expect(stop.textContent).toBe("Stop");
    expect(mounted.element.shadowRoot!.activeElement).toBe(stop);
    expect(live(mounted.element)?.textContent).toBe("An assistant started working on this form: Filling your claim. Press Stop to take over.");
    // Inside the session the focused field is written.
    const written = await mounted.ok("set_answers", { answers: { fullName: "Ada" } });
    expect(writtenPaths(written)).toEqual(["fullName"]);

    const ended = await mounted.ok("end_session", { summary: "Your name is in." });
    expect(ended).toMatchObject({ wasOpen: true });
    expect(mounted.element.renderer!.hasAttribute("inert")).toBe(false);
    expect(bannerText(mounted.element)).toBe("The assistant finished: Your name is in.");
    const undoAll = region.querySelector<HTMLButtonElement>("[data-agent-undo-all]")!;
    const dismiss = region.querySelector<HTMLButtonElement>("[data-agent-dismiss]")!;
    expect(undoAll.textContent).toBe("Undo all");
    expect(dismiss.textContent).toBe("Dismiss");
    expect(region.querySelector("[data-agent-stop]")).toBeNull();
    // Focus was on Stop: it stays in the banner, on the first button of the new state.
    expect(mounted.element.shadowRoot!.activeElement).toBe(undoAll);
    undoAll.click();
    expect(region.querySelector("[data-agent-undo-all]")).toBeNull();
    expect(mounted.element.shadowRoot!.activeElement).toBe(dismiss);
    dismiss.click();
    expect(region.hidden).toBe(true);
  });

  it("begin_session leaves focus alone when the person is in a field outside the form", async () => {
    const mounted = await mount();
    const chat = document.createElement("input");
    document.body.append(chat);
    chat.focus();
    expect(document.activeElement).toBe(chat);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await mounted.ok("begin_session", { purpose: "Filling" });
    expect(mounted.element.renderer!.hasAttribute("inert")).toBe(true);
    expect(banner(mounted.element)!.querySelector("[data-agent-stop]")).not.toBeNull();
    expect(document.activeElement).toBe(chat);
    await mounted.ok("end_session", { summary: "Done." });
  });

  it("a resumed begin_session redraws the banner with the new purpose, announces nothing new and moves no focus", async () => {
    const mounted = await mount();
    // Focus nowhere: the first begin takes it to Stop.
    (document.activeElement as HTMLElement | null)?.blur?.();
    await mounted.ok("begin_session", { purpose: "Filling your claim" });
    const stop = banner(mounted.element)!.querySelector<HTMLButtonElement>("[data-agent-stop]")!;
    expect(mounted.element.shadowRoot!.activeElement).toBe(stop);
    const started = live(mounted.element)?.textContent;
    expect(started).toBe("An assistant started working on this form: Filling your claim. Press Stop to take over.");
    // The person puts focus back on the page's body; a resumed begin must leave it there.
    stop.blur();
    expect(mounted.element.shadowRoot!.activeElement).toBeNull();
    const resumed = await mounted.ok("begin_session", { purpose: "Checking your address" });
    expect(resumed.resumed).toBe(true);
    expect(bannerText(mounted.element)).toBe("An assistant is working on this form: Checking your address");
    expect(banner(mounted.element)!.querySelectorAll("[data-agent-stop]")).toHaveLength(1);
    expect(mounted.element.shadowRoot!.activeElement).toBeNull();
    expect(live(mounted.element)?.textContent).toBe(started);
    expect(mounted.element.renderer!.hasAttribute("inert")).toBe(true);
    await mounted.ok("end_session", { summary: "Done." });
  });

  it("keeps one banner and one live region across a features toggle, and a withdrawn registration leaves no banner up", async () => {
    const mounted = await mount();
    const root = mounted.element.shadowRoot!;
    await mounted.ok("begin_session", { purpose: "Filling" });
    await mounted.ok("set_answers", { answers: { fullName: "Ada" } });
    await mounted.ok("end_session", { summary: "Done." });
    expect(banner(mounted.element)!.hidden).toBe(false);
    expect(root.querySelector("[data-agent-undo-all]")).not.toBeNull();

    mounted.element.features = "all";
    await settle();
    expect(banner(mounted.element)!.hidden).toBe(true);
    expect(root.querySelectorAll("[data-agent-banner] button")).toHaveLength(0);

    mounted.element.features = "all agent";
    await settle();
    await mounted.ok("set_answers", { answers: { subscribe: true } });
    await mounted.ok("begin_session", { purpose: "Again" });
    expect(root.querySelectorAll("[data-agent-live]")).toHaveLength(1);
    expect(root.querySelectorAll("[data-agent-banner]")).toHaveLength(1);
    await mounted.ok("end_session", { summary: "Done." });

    // Moved in the DOM (disconnect, connect): still one of each.
    document.body.append(mounted.element);
    await settle();
    await mounted.ok("set_answers", { answers: { fullName: "Grace" } });
    await mounted.ok("begin_session", { purpose: "Moved" });
    expect(root.querySelectorAll("[data-agent-live]")).toHaveLength(1);
    expect(root.querySelectorAll("[data-agent-banner]")).toHaveLength(1);
    await mounted.ok("end_session", { summary: "Done." });
  });

  it("Stop restores the session's writes, shows the stopped banner with Allow again, holds writes until the person allows again", async () => {
    const mounted = await mount();
    await mounted.ok("begin_session", { purpose: "Filling" });
    await mounted.ok("set_answers", { answers: { fullName: "Ada", subscribe: true } });
    expect(mounted.element.runtime!.formValues().fullName).toBe("Ada");
    banner(mounted.element)!.querySelector<HTMLButtonElement>("[data-agent-stop]")!.click();
    await until(() => mounted.element.runtime!.formValues().fullName === undefined);
    expect(mounted.element.runtime!.formValues().subscribe).toBeFalsy();
    expect(mounted.element.renderer!.hasAttribute("inert")).toBe(false);
    await until(() => bannerText(mounted.element) === "The assistant was stopped; 2 changes were undone");
    const allowAgain = banner(mounted.element)!.querySelector<HTMLButtonElement>("[data-agent-allow-again]")!;
    expect(allowAgain.textContent).toBe("Allow the assistant again");
    // The person was on Stop: their place is on Allow again, not lost to the page's body.
    expect(mounted.element.shadowRoot!.activeElement).toBe(allowAgain);
    expect(live(mounted.element)?.textContent).toBe("The assistant was stopped; 2 changes were undone");

    const held = await mounted.refused("set_answers", { answers: { fullName: "Grace" } });
    expect(held.code).toBe("stopped");
    // The first result after Stop carries the end once.
    expect(held.sessionEnded).toEqual({ reason: "stopped", undone: 2 });
    const read = await mounted.ok("get_answers", {});
    expect(read.ok).toBe(true);

    allowAgain.click();
    expect(banner(mounted.element)!.hidden).toBe(true);
    const again = await mounted.ok("set_answers", { answers: { fullName: "Grace" } });
    expect(writtenPaths(again)).toEqual(["fullName"]);
  });
});

describe("readiness and the memo's data sources", () => {
  it("answers form-not-ready { state: loading } from agentBuildState while a src swap waits for its journeys runtime, then describes the new form", async () => {
    const mounted = await mount();
    expect(mounted.element.agentBuildState).toBe("ready");
    const before = await mounted.ok("describe_form", {});
    expect(before.formId).toBe("sample-form");

    gate.hold = true;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(journeyDefinition()), { status: 200, headers: { "content-type": "application/json" } }));
    // One source at a time: the page clears the assigned form before it points src elsewhere.
    mounted.element.definition = undefined;
    mounted.element.src = "/forms/flow.json";
    await until(() => mounted.element.agentBuildState === "loading");
    const loading = await mounted.refused("describe_form", {});
    expect(loading).toMatchObject({ code: "form-not-ready", retryable: true, details: { state: "loading" } });
    expect(loading.hint).toBe("Wait a moment and call describe_form again.");

    await until(() => gate.release !== undefined);
    gate.hold = false;
    gate.release!();
    await mounted.element.ready;
    await until(() => mounted.element.agentBuildState === "ready");
    const after = await mounted.ok("describe_form", {});
    expect(after.formId).toBe("flow-form");
    expect(after.structure).toBe("pages");
  });

  it("reads a journey's pages through the renderer's drawn kit: titles, the current page's fields, and a later page named on a write", async () => {
    const mounted = await mount({}, undefined, journeyDefinition());
    // The kit the renderer draws with, which the element host hands describe.ts.
    expect(mounted.element.renderer!.journeyKit?.id).not.toBe("noop");
    const described = await mounted.ok("describe_form", {});
    expect(described.structure).toBe("pages");
    expect((described.pages as Row[]).map((page) => page.title)).toEqual(["Page one", "Page two"]);
    expect((described.fields as Row[]).map((field) => field.path)).toEqual(["first"]);

    const written = await mounted.ok("set_answers", { answers: { second: "later" } });
    expect(written.elsewhere).toEqual([{ path: "second", id: "second", page: "two" }]);
  });

  it("builds the memo over the renderer's timed data sources: a source that never answers fails at data-source-timeout instead of hanging", async () => {
    const mounted = await mount({ "data-source-timeout": "80" }, (element) => {
      element.dataSources = { countries: () => new Promise(() => undefined) } as never;
    }, sampleDefinition());
    const started = Date.now();
    const options = await mounted.ok("get_options", { field: "country" });
    expect(options.status).toBe("error");
    expect(options.options).toEqual([]);
    expect(options.provisional).toBeUndefined();
    expect(options.warnings).toEqual(["options for country failed to load"]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("submit through the element", () => {
  it("fires datum-agent-action started / done around datum-submit with trigger: agent, and the runtime sees only the provenance account: no signWith, signing or trigger", async () => {
    const mounted = await mount();
    await mounted.ok("set_answers", { answers: { fullName: "Ada" } });
    const runtime = mounted.element.runtime!;
    const spy = vi.spyOn(runtime, "submit");
    const submits: DatumFormSubmitDetail[] = [];
    mounted.element.addEventListener("datum-submit", (event) => submits.push((event as CustomEvent<DatumFormSubmitDetail>).detail));
    mounted.actions.length = 0;

    const result = await mounted.ok("submit", {});
    expect(result.status).toBe("accepted");
    expect(submits).toHaveLength(1);
    expect(submits[0]!.trigger).toBe("agent");
    expect(submits[0]!.accepted).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const options = spy.mock.calls[0]![2] as Record<string, unknown>;
    // The runtime is handed the provenance account, the element's own
    // `agent: true` never; it copies the account into the submit hooks alone.
    expect(Object.keys(options)).toEqual(["agent"]);
    expect(options.agent).toMatchObject({ version: 1, involved: true, paths: ["fullName"], submittedBy: "agent" });
    expect(submits[0]!.agent).toEqual(options.agent);
    expect(options).not.toHaveProperty("signWith");
    expect(options).not.toHaveProperty("signing");
    expect(options).not.toHaveProperty("trigger");

    const submitActions = mounted.actions.filter((detail) => detail.tool === "submit");
    expect(submitActions.map((detail) => (detail.outcome as Row).code ?? (detail.outcome as Row).ok)).toEqual(["started", true]);
    expect(submitActions[0]).toMatchObject({ trigger: "agent", target: "form", readOnly: false });
    expect(submitActions[1]).toMatchObject({ trigger: "agent", target: "form", handle: result.form, changed: true });
    expect(live(mounted.element)?.textContent).toBe("An assistant submitted the form");
  });

  it("an agent's submit moves no focus: a refused one leaves the errors unfocused, an accepted one draws the confirmation unfocused", async () => {
    const mounted = await mount({ confirmation: "" });
    const renderer = mounted.element.renderer!;
    const firstError = vi.spyOn(renderer, "focusFirstError");
    const focusNotice = vi.spyOn(renderer, "focusNotice");
    const refusedSubmit = await mounted.execute("submit", {});
    expect((refusedSubmit as unknown as Row).ok === false || (refusedSubmit as unknown as Row).status !== "accepted").toBe(true);
    expect(firstError).not.toHaveBeenCalled();

    await mounted.ok("set_answers", { answers: { fullName: "Ada" } });
    const accepted = await mounted.ok("submit", {});
    expect(accepted.status).toBe("accepted");
    expect(mounted.element.notice?.kind).toBe("success");
    expect(focusNotice).not.toHaveBeenCalled();
    expect(firstError).not.toHaveBeenCalled();

    // The person's own refused submit still takes them to the first error.
    mounted.element.runtime!.setValues({ fullName: "" });
    await mounted.element.submit();
    expect(firstError).toHaveBeenCalledTimes(1);
  });

  // On a journey the renderer's own page-change focus (applyPageFocus, fed by
  // PAGE_CHANGED) would move focus for an agent's refused submit (direction "error") and its
  // navigate (the page heading); runSubmit and the host's quietPageFocus call the renderer's
  // quietNextPageFocus() first, so the page paints and focus stays put.
  it("on a journey, an agent's refused submit with the error on an earlier page leaves focus in the person's chat box", async () => {
    const definition = journeyDefinition();
    const first = (definition.root.children!.content as Array<{ id: string; configuration: Row }>).find((node) => node.id === "first")!;
    first.configuration = { ...first.configuration, required: true };
    const mounted = await mount({}, undefined, definition);
    await mounted.ok("set_answers", { answers: { first: "A" } });
    await mounted.ok("navigate", { to: "next" });
    await mounted.ok("set_answers", { answers: { first: "" } });
    const chat = document.createElement("input");
    document.body.append(chat);
    chat.focus();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const firstError = vi.spyOn(mounted.element.renderer!, "focusFirstError");
    const result = await mounted.refused("submit", {});
    expect(result.code).toBe("rejected");
    await settle();
    expect(firstError).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(chat);
  });

  it("on a journey, an agent's navigate leaves focus in the person's chat box", async () => {
    const mounted = await mount({}, undefined, journeyDefinition());
    const chat = document.createElement("input");
    document.body.append(chat);
    chat.focus();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await mounted.ok("navigate", { to: "next" });
    await settle();
    expect(document.activeElement).toBe(chat);
  });

  it("on a journey, an agent's navigate while the person's focus is on a control of the page being left focuses the new page's heading", async () => {
    const mounted = await mount({}, undefined, journeyDefinition());
    const root = mounted.element.renderer!.shadowRoot!;
    const control = root.querySelector<HTMLInputElement>("input")!;
    control.focus();
    expect(root.activeElement).toBe(control);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await mounted.ok("navigate", { to: "next" });
    await settle();
    const heading = root.querySelector<HTMLElement>("[data-journey-heading]");
    expect(heading?.textContent).toContain("Page two");
    expect(root.activeElement).toBe(heading);
  });

  it("on a journey, an agent's refused navigate leaves no quiet behind: the host's own nextPage() then focuses the heading", async () => {
    const definition = journeyDefinition();
    const first = (definition.root.children!.content as Array<{ id: string; configuration: Row }>).find((node) => node.id === "first")!;
    first.configuration = { ...first.configuration, required: true };
    const mounted = await mount({}, undefined, definition);
    const chat = document.createElement("input");
    document.body.append(chat);
    chat.focus();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const refused = await mounted.refused("navigate", { to: "next" });
    expect(refused.code).toBe("blocked");
    await settle();
    expect(document.activeElement).toBe(chat);

    mounted.element.runtime!.setValues({ first: "A" });
    expect((await mounted.element.nextPage()).ok).toBe(true);
    await settle();
    const root = mounted.element.renderer!.shadowRoot!;
    const heading = root.querySelector<HTMLElement>("[data-journey-heading]");
    expect(heading?.textContent).toContain("Page two");
    expect(root.activeElement).toBe(heading);
  });

  it("the person's own submit() carries no trigger", async () => {
    const mounted = await mount();
    mounted.element.runtime!.setValues({ fullName: "Ada" });
    const detail = await mounted.element.submit();
    expect(detail.accepted).toBe(true);
    expect("trigger" in detail).toBe(false);
  });
});

// ---- drafts, the PDF and provenance on the element ----

interface DraftCall {
  method: string;
  url: string;
}

/** A fetch that is a tiny draft service (the form-element-draft-store pattern): PUT stores, GET reads or 404s, DELETE removes. */
function stubDraftService(): { calls: DraftCall[]; drafts: Map<string, FormDraft> } {
  const calls: DraftCall[] = [];
  const drafts = new Map<string, FormDraft>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      const id = decodeURIComponent(url.split("/").pop() ?? "");
      if (method === "PUT" && typeof init?.body === "string") {
        drafts.set(id, JSON.parse(init.body) as FormDraft);
        return new Response(null, { status: 204 });
      }
      if (method === "DELETE") {
        drafts.delete(id);
        return new Response(null, { status: 204 });
      }
      const found = drafts.get(id);
      return found ? new Response(JSON.stringify(found), { status: 200 }) : new Response("missing", { status: 404, statusText: "Not Found" });
    })
  );
  return { calls, drafts };
}

/** A PDF support whose provider answers at once, recording each request the kernel would get. */
function fakePdfSupport(seen: unknown[]): import("../src/pdf.js").DatumPdfSupport {
  return {
    provider: {
      id: "fake",
      abiVersion: "4.0.0",
      render: async (request: unknown) => {
        seen.push(request);
        return { bytes: new TextEncoder().encode("%PDF-fake"), pageCount: 1, pages: [], warnings: [], providerId: "fake" };
      }
    }
  } as unknown as import("../src/pdf.js").DatumPdfSupport;
}

/** Every `datum-pdf` detail, the event cancelled so the page takes the file (jsdom makes no blob URLs). */
function takePdfs(element: DatumFormElement): DatumPdfDetail[] {
  const details: DatumPdfDetail[] = [];
  element.addEventListener("datum-pdf", (event) => {
    event.preventDefault();
    details.push((event as CustomEvent<DatumPdfDetail>).detail);
  });
  return details;
}

describe("drafts on the element", () => {
  it("answers the store kind in <datum-form>'s own order: browser, server, page", async () => {
    const browser = await mount({ draft: "kind-browser" });
    expect((await browser.ok("drafts", { action: "save" })).store).toBe("browser");
    browser.element.remove();

    const { calls } = stubDraftService();
    const server = await mount({ draft: "kind-server", "draft-store": "server:/api/drafts" });
    expect((await server.ok("drafts", { action: "save" })).store).toBe("server");
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    server.element.remove();

    const saved: FormDraft[] = [];
    const page = await mount({ draft: "kind-page", "draft-store": "server:/api/drafts" }, (element) => {
      element.draftStore = {
        save: async (draft) => void saved.push(draft),
        load: async () => {
          throw new Error("none");
        },
        list: async () => [],
        delete: async () => undefined
      };
    });
    const result = await page.ok("drafts", { action: "save" });
    expect(result.store).toBe("page");
    expect(saved.map((draft) => draft.id)).toEqual(["kind-page"]);
    // Nothing of the store leaves through the result: never its key or URL.
    expect(JSON.stringify(result)).not.toContain("kind-page");
    expect(JSON.stringify(result)).not.toContain("/api/drafts");

    // A page that cleared the property with null saves where the element then saves: the
    // browser here, with no draft-store attribute, and the answer says so.
    page.element.remove();
    const cleared = await mount({ draft: "kind-cleared" }, (element) => {
      element.draftStore = null as unknown as undefined;
    });
    expect((await cleared.ok("drafts", { action: "save" })).store).toBe("browser");
    cleared.element.remove();

    // Without a draft key the form keeps no draft.
    const none = await mount();
    expect((await none.refused("drafts", { action: "save" })).code).toBe("no-drafts");
  });

  it("saveDraft() clears the autosave timer: an agent write then drafts { save } sends one PUT, not two", async () => {
    const { calls } = stubDraftService();
    const mounted = await mount({ draft: "once", "draft-store": "server:/api/drafts" });
    await mounted.ok("set_answers", { answers: { fullName: "Ada Lovelace" } });
    const saved = await mounted.ok("drafts", { action: "save" });
    expect(saved).toMatchObject({ action: "save", store: "server", undoable: false });
    expect(typeof saved.savedAt).toBe("number");
    // Past the 300 ms autosave pause: the write's own autosave was cleared by the save.
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);

    // The public method answers the saved draft's summary, the same way.
    const summary = await mounted.element.saveDraft();
    expect(summary.id).toBe("once");
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(2);
  });

  it("clearDraft() stops the autosave the last write armed: an agent write then drafts { clear } leaves the draft deleted", async () => {
    const { calls, drafts } = stubDraftService();
    const mounted = await mount({ draft: "gone", "draft-store": "server:/api/drafts" });
    await mounted.ok("set_answers", { answers: { fullName: "Agent Name" } });
    await mounted.ok("drafts", { action: "save" });
    expect(drafts.has("gone")).toBe(true);
    // A second write arms the autosave again; the clear must stop it.
    await mounted.ok("set_answers", { answers: { fullName: "Agent Name Again" } });
    await mounted.ok("drafts", { action: "clear" });
    // Past the 300 ms autosave pause: nothing after the DELETE puts the draft back.
    await new Promise((resolve) => setTimeout(resolve, 450));
    const methods = calls.map((call) => call.method);
    expect(methods.slice(methods.lastIndexOf("DELETE") + 1)).not.toContain("PUT");
    expect(drafts.has("gone")).toBe(false);

    // The person's own clearDraft() right after typing does the same.
    mounted.element.runtime!.setValues({ fullName: "Typed Name" });
    await mounted.element.saveDraft();
    mounted.element.runtime!.setValues({ fullName: "Typed Again" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await mounted.element.clearDraft();
    await new Promise((resolve) => setTimeout(resolve, 450));
    const after = calls.map((call) => call.method);
    expect(after.slice(after.lastIndexOf("DELETE") + 1)).not.toContain("PUT");
    expect(drafts.has("gone")).toBe(false);
  });

  it("restoreDraft() resolves { updatedAt, locale }; drafts { restore } of a journey draft keeps the person's focus outside the form", async () => {
    const { drafts } = stubDraftService();
    const first = await mount({ draft: "trip", "draft-store": "server:/api/drafts" }, undefined, journeyDefinition());
    await first.ok("set_answers", { answers: { first: "Kept" } });
    await first.ok("navigate", { to: "next" });
    // The page change saves the draft at once.
    await until(() => (drafts.get("trip")?.values as Row | undefined)?.first === "Kept");
    const stored = drafts.get("trip")!;
    first.element.remove();

    const second = await mount({ draft: "trip", "draft-store": "server:/api/drafts" }, undefined, journeyDefinition());
    const chat = document.createElement("input");
    document.body.append(chat);
    chat.focus();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    // The host's quiet seam is what keeps focus here: asked once, for the agent's restore only.
    const quiet = vi.spyOn(second.element.renderer!, "quietNextPageFocus");
    const restored = await second.ok("drafts", { action: "restore" });
    expect(quiet).toHaveBeenCalledTimes(1);
    expect(restored).toMatchObject({ action: "restore", store: "server", savedAt: stored.updatedAt, locale: "en", page: { id: "two" } });
    await settle();
    expect(document.activeElement).toBe(chat);
    expect(second.element.values.first).toBe("Kept");

    // The public method resolves when the draft was saved and the language it put the form in.
    second.element.runtime!.setValues({ first: "" });
    await expect(second.element.restoreDraft()).resolves.toEqual({ updatedAt: stored.updatedAt, locale: "en" });
    await settle();
    expect(document.activeElement).toBe(chat);
    expect(quiet).toHaveBeenCalledTimes(1);
  });

  it("restoreDraft() rejects with the store's DraftError when nothing is saved, and drafts { restore } answers no-draft", async () => {
    stubDraftService();
    const mounted = await mount({ draft: "missing", "draft-store": "server:/api/drafts" });
    await expect(mounted.element.restoreDraft()).rejects.toMatchObject({ name: "DraftError", code: "draft.notFound" });
    expect((await mounted.refused("drafts", { action: "restore" })).code).toBe("no-draft");
  });

  it("a restore inside a session ends with the Dismiss-only banner and the ended line from the form texts", async () => {
    stubDraftService();
    const mounted = await mount({ draft: "in-session", "draft-store": "server:/api/drafts" });
    await mounted.ok("set_answers", { answers: { fullName: "Saved Name" } });
    await mounted.ok("drafts", { action: "save" });
    await mounted.ok("begin_session", { purpose: "Bringing back your draft" });
    await mounted.ok("set_answers", { answers: { fullName: "Before restore" } });
    await mounted.ok("drafts", { action: "restore", replaceAnswers: true });
    expect(mounted.element.values.fullName).toBe("Saved Name");
    await mounted.ok("end_session", { summary: "Your draft is back." });
    const region = banner(mounted.element)!;
    expect(region.hidden).toBe(false);
    expect(bannerText(mounted.element)).toBe("The assistant finished: Your draft is back.");
    expect(region.querySelector("[data-agent-banner-note]")?.textContent).toBe("A saved draft replaced the answers; earlier changes cannot be undone.");
    // Nothing after the restore to undo: Dismiss alone.
    expect(region.querySelector("[data-agent-undo-all]")).toBeNull();
    const dismiss = region.querySelector<HTMLButtonElement>("[data-agent-dismiss]")!;
    expect(dismiss.textContent).toBe("Dismiss");
    dismiss.click();
    expect(region.hidden).toBe(true);
  });
});

describe("the PDF on the element", () => {
  it("download_pdf puts trigger: agent and the provenance on datum-pdf; neither reaches the renderer's request; the person's button carries no trigger", async () => {
    const seen: unknown[] = [];
    const mounted = await mount(
      {},
      (element) => {
        element.pdfSupport = fakePdfSupport(seen);
      },
      buttonsDefinition()
    );
    const pdfs = takePdfs(mounted.element);
    await mounted.ok("set_answers", { answers: { fullName: "Ada Lovelace" } });
    const result = await mounted.ok("download_pdf", {});
    expect(result).toMatchObject({ delivered: "page", changed: true, undoable: false, pageCount: 1 });
    expect(pdfs).toHaveLength(1);
    expect(pdfs[0]!.trigger).toBe("agent");
    expect(pdfs[0]!.agent).toMatchObject({ version: 1, involved: true, paths: ["fullName"], submittedBy: "agent", complete: true });
    // The kernel's request knows nothing of who asked.
    expect(JSON.stringify(seen[0])).not.toContain("submittedBy");
    expect(JSON.stringify(seen[0])).not.toContain("\"trigger\"");

    // The person's own download: the account, no trigger.
    await mounted.element.downloadPdf();
    expect(pdfs).toHaveLength(2);
    expect("trigger" in pdfs[1]!).toBe(false);
    expect(pdfs[1]!.agent).toMatchObject({ involved: true, submittedBy: "page" });

    // The person's PDF button: agent on every datum-pdf: the same, through the button.
    mounted.shadow().querySelector<HTMLElement>('[data-button-action="pdf"]')!.click();
    await until(() => pdfs.length === 3);
    expect("trigger" in pdfs[2]!).toBe(false);
    expect(pdfs[2]!.agent).toMatchObject({ involved: true, paths: ["fullName"], submittedBy: "page" });
  });

  it("downloadPdf({ agent: true }) strips agent before the renderer: the renderer gets trigger and the account only", async () => {
    const seen: unknown[] = [];
    const mounted = await mount({}, (element) => {
      element.pdfSupport = fakePdfSupport(seen);
    });
    takePdfs(mounted.element);
    const renderer = mounted.element.renderer!;
    const spy = vi.spyOn(renderer, "downloadPdf");
    mounted.element.runtime!.setValues({ fullName: "Ada Lovelace" });
    const outcome = await mounted.element.downloadPdf({ layoutId: "", agent: true });
    expect(outcome.cancelled).toBe(true);
    const options = spy.mock.calls[0]![0] as Record<string, unknown>;
    expect(options.trigger).toBe("agent");
    expect(options.agent).toMatchObject({ version: 1, submittedBy: "agent", involved: false });
    expect(Object.keys(options).sort()).toEqual(["agent", "layoutId", "trigger"]);
  });

  it("refuses download_pdf with signature-required when the page signs its PDFs, and never calls the signer", async () => {
    const seen: unknown[] = [];
    const sign = vi.fn();
    const mounted = await mount({ features: "all agent" }, (element) => {
      element.pdfSupport = fakePdfSupport(seen);
      element.pdfSigner = { sign } as unknown as NonNullable<DatumFormElement["pdfSigner"]>;
    });
    expect(mounted.element.agentPdfSigns).toBe(true);
    await mounted.ok("set_answers", { answers: { fullName: "Ada Lovelace" } });
    const refused = await mounted.refused("download_pdf", {});
    expect(refused.code).toBe("signature-required");
    expect(sign).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it("answers no-pdf when the page makes no PDF of the form", async () => {
    const mounted = await mount();
    expect((await mounted.refused("download_pdf", {})).code).toBe("no-pdf");
  });
});

describe("provenance on datum-submit", () => {
  /** A plugin whose beforeSubmit hook keeps the context's `agent` (the runtime's frozen copy). */
  function hookSpy(): { plugin: FormPlugin; seen: Array<AgentProvenance | undefined> } {
    const seen: Array<AgentProvenance | undefined> = [];
    const plugin = {
      id: "provenance-spy",
      version: "1",
      hooks: {
        beforeSubmit: [
          (context: { agent?: AgentProvenance }) => {
            seen.push(context.agent === undefined ? undefined : structuredClone(context.agent));
          }
        ]
      }
    } as unknown as FormPlugin;
    return { plugin, seen };
  }

  function submits(element: DatumFormElement): DatumFormSubmitDetail[] {
    const details: DatumFormSubmitDetail[] = [];
    element.addEventListener("datum-submit", (event) => details.push((event as CustomEvent<DatumFormSubmitDetail>).detail));
    return details;
  }

  it("carries agent on both routes: the submit tool (submittedBy agent) and the person's own submit (submittedBy page); the hooks get the same account", async () => {
    const spy = hookSpy();
    const mounted = await mount(
      {},
      (element) => {
        element.plugins = [spy.plugin];
      },
      buttonsDefinition()
    );
    const details = submits(mounted.element);
    await mounted.ok("set_answers", { answers: { fullName: "Ada Lovelace" } });
    await mounted.ok("submit", {});
    expect(details[0]!.trigger).toBe("agent");
    expect(details[0]!.agent).toMatchObject({ version: 1, involved: true, paths: ["fullName"], tables: [], complete: true, submittedBy: "agent", sessionOpen: false });
    expect(spy.seen[0]).toEqual(details[0]!.agent);

    // The person's own submit(): the agent still wrote the name last.
    const detail = await mounted.element.submit();
    expect("trigger" in detail).toBe(false);
    expect(detail.agent).toMatchObject({ involved: true, submittedBy: "page" });
    expect(spy.seen).toHaveLength(2);
    expect(spy.seen[1]).toMatchObject({ submittedBy: "page" });

    // The person's Submit button: the same account, no trigger.
    mounted.shadow().querySelector<HTMLElement>('[data-button-action="submit"]')!.click();
    await until(() => details.length === 3);
    expect("trigger" in details[2]!).toBe(false);
    expect(details[2]!.agent).toMatchObject({ involved: true, paths: ["fullName"], submittedBy: "page" });
    expect(spy.seen[2]).toMatchObject({ submittedBy: "page" });
  });

  it("a name the person typed over after the agent is not in paths", async () => {
    const mounted = await mount();
    await mounted.ok("set_answers", { answers: { fullName: "Ada Lovelace" } });
    mounted.element.runtime!.setValues({ fullName: "Grace Hopper" });
    const detail = await mounted.element.submit();
    expect(detail.agent).toMatchObject({ involved: true, paths: [] });
  });

  it("is absent with the token never on: no agent on datum-submit, none on datum-pdf, none in the hooks", async () => {
    const spy = hookSpy();
    const seen: unknown[] = [];
    const mounted = await mount({ features: "all" }, (element) => {
      element.plugins = [spy.plugin];
      element.pdfSupport = fakePdfSupport(seen);
    });
    const runtimeSubmit = vi.spyOn(mounted.element.runtime!, "submit");
    const pdfs = takePdfs(mounted.element);
    mounted.element.runtime!.setValues({ fullName: "Ada Lovelace" });
    const detail = await mounted.element.submit();
    expect(detail.accepted).toBe(true);
    expect("agent" in detail).toBe(false);
    expect(spy.seen).toEqual([undefined]);
    expect(runtimeSubmit.mock.calls[0]![2]).not.toHaveProperty("agent");
    await mounted.element.downloadPdf();
    expect("agent" in pdfs[0]!).toBe(false);
    expect("trigger" in pdfs[0]!).toBe(false);
  });

  it("stays present with involved: true and complete: false after the token goes, once the agent wrote", async () => {
    const mounted = await mount();
    await mounted.ok("begin_session", { purpose: "Filling your name" });
    const before = Date.now();
    await mounted.ok("set_answers", { answers: { fullName: "Ada Lovelace" } });
    await mounted.ok("end_session", { summary: "Your name is in." });
    const written = (await mounted.element.submit()).agent!.lastWriteAt!;
    expect(written).toBeGreaterThanOrEqual(before);
    mounted.element.setAttribute("features", "all");
    await until(() => mounted.element.features?.includes("agent") === false);
    const detail = await mounted.element.submit();
    expect(detail.accepted).toBe(true);
    // The last write's time is kept with the rest (absent only when the agent never wrote).
    expect(detail.agent).toEqual({ version: 1, involved: true, paths: [], tables: [], complete: false, submittedBy: "page", sessions: 1, sessionOpen: false, lastWriteAt: written });

    // Back on: a fresh registration knows nothing of the earlier writes, and the account says so.
    mounted.element.setAttribute("features", "all agent");
    await mounted.element.agentTools();
    const again = await mounted.element.submit();
    expect(again.agent).toMatchObject({ involved: true, complete: false, submittedBy: "page", sessions: 1, lastWriteAt: written });
    // Its own writes are traced again, and the earlier registration's still are not.
    await mounted.ok("set_answers", { answers: { fullName: "Grace Hopper" } });
    const third = await mounted.element.submit();
    expect(third.agent).toMatchObject({ involved: true, paths: ["fullName"], complete: false, sessions: 1 });
  });

  it("is present with involved: false after a detach that followed no write", async () => {
    const mounted = await mount();
    await mounted.ok("describe_form", {});
    mounted.element.setAttribute("features", "all");
    await until(() => mounted.element.features?.includes("agent") === false);
    mounted.element.runtime!.setValues({ fullName: "Ada Lovelace" });
    const detail = await mounted.element.submit();
    expect(detail.agent).toEqual({ version: 1, involved: false, paths: [], tables: [], complete: true, submittedBy: "page", sessions: 0, sessionOpen: false });
  });
});
