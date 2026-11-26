import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The builder catalogue's element host in jsdom: `<datum-form-builder features="all agent">` registers the
 * builder's twenty-four tools beside the page's session pair, its writes land on the canvas, the
 * banner / notice / live region live once in the wrapper's shadow root, the shell goes inert
 * during a session with focus on Stop only when it was the builder's, Stop undoes the session's
 * steps, the highlight is timed on the canvas, nothing scrolls or flashes while the person types
 * in the inspector, an agent-only features change keeps the builder's state, a reseed is a
 * rebuild under the attach-order rule, the person's own edit dismisses the notice and the
 * summary banner, `canTry` and the `pdfFindings` gate read the wrapper, and the
 * engine shell used bare loads nothing. jsdom lays nothing out: attributes and
 * text only.
 */
const loads = vi.hoisted(() => ({ builder: 0, form: 0, hold: false }));
vi.mock("../src/agent-loader.js", async (original) => {
  const real = await original<typeof import("../src/agent-loader.js")>();
  return {
    ...real,
    loadAgent: () => {
      loads.form += 1;
      return real.loadAgent();
    },
    // Counted, and held (never settling) while `hold` is set: an element whose own attachment
    // must not land, so a test's direct attach is the page's only builder registration.
    loadBuilderAgent: () => {
      loads.builder += 1;
      return loads.hold ? new Promise<never>(() => undefined) : real.loadBuilderAgent();
    }
  };
});

import "../src/form.js";
import "../src/builder.js";
import { bindings } from "../src/form.js";
import type { DatumFormElement } from "../src/form.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { DatumAgentToolsDetail } from "../src/agent.js";
import { attachBuilderAgent } from "../src/builder/agent.js";
import { elementBuilderHost } from "../src/builder/agent-host.js";
import { BUILDER_AGENT_TOOL_NAMES, SESSION_TOOL_NAMES, agentRegistrarFor, type AgentToolResult } from "@argusvane/datum-engine/agent";
import { createFakeModelContext } from "@argusvane/datum-engine/testing";
import { DATUM_BUILDER_TAG_NAME, pdfLayoutConditionFindings, type FormDefinition } from "@argusvane/datum-engine";

import { sampleDefinition, until } from "./helpers.js";

type Row = Record<string, unknown>;

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

/*
 * One fake ModelContext for the file, installed before any element mounts: the page registrar
 * binds to the API it first finds and keeps it (a real page never swaps document.modelContext),
 * so a fresh fake per test would leave it bound to one a test already took away. Every test's
 * elements leave the page in afterEach, which withdraws their tools from this fake.
 */
const mc = createFakeModelContext();
let restoreModelContext: () => void = () => undefined;

beforeAll(() => {
  restoreModelContext = mc.install(document);
});

afterAll(() => {
  restoreModelContext();
});

beforeEach(() => {
  unhandled.length = 0;
  loads.builder = 0;
  loads.form = 0;
  loads.hold = false;
  process.on("unhandledRejection", onUnhandled);
});

afterEach(async () => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  await settle();
  process.off("unhandledRejection", onUnhandled);
  vi.restoreAllMocks();
  expect(unhandled).toEqual([]);
});

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

interface Mounted {
  element: DatumFormBuilderElement;
  actions: Row[];
  sessions: Row[];
  toolsEvents: DatumAgentToolsDetail[];
  errors: Array<{ message: string }>;
  ok(name: string, input?: unknown): Promise<Row>;
  refused(name: string, input?: unknown): Promise<Row>;
}

function listen(element: HTMLElement): Pick<Mounted, "actions" | "sessions" | "toolsEvents" | "errors"> {
  const actions: Row[] = [];
  const sessions: Row[] = [];
  const toolsEvents: DatumAgentToolsDetail[] = [];
  const errors: Array<{ message: string }> = [];
  element.addEventListener("datum-agent-action", (event) => actions.push((event as CustomEvent<Row>).detail));
  element.addEventListener("datum-agent-session", (event) => sessions.push((event as CustomEvent<Row>).detail));
  element.addEventListener("datum-agent-tools", (event) => toolsEvents.push((event as CustomEvent<DatumAgentToolsDetail>).detail));
  element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail));
  return { actions, sessions, toolsEvents, errors };
}

function okOf(name: string, result: AgentToolResult): Row {
  if (!result.ok) {
    throw new Error(`${name} refused: ${result.code}: ${result.message} ${JSON.stringify(result.details ?? {})}`);
  }
  return result as unknown as Row;
}

async function mount(attributes: Record<string, string> = {}, definition: FormDefinition = sampleDefinition()): Promise<Mounted> {
  const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
  const heard = listen(element);
  element.setAttribute("features", "all agent");
  element.setAttribute("pdf", "off");
  element.setAttribute("journeys", "off");
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  element.definition = definition;
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  // A held loader (loads.hold) never lands: nothing to wait for then.
  if (element.featureEnabled("agent") && !loads.hold) {
    await element.agentTools();
  }
  const execute = (name: string, input: unknown = {}): Promise<AgentToolResult> => element.executeAgentTool(name, input);
  return {
    element,
    ...heard,
    ok: async (name, input = {}) => okOf(name, await execute(name, input)),
    async refused(name, input = {}) {
      const result = await execute(name, input);
      if (result.ok) {
        throw new Error(`${name} was not refused: ${JSON.stringify(result).slice(0, 300)}`);
      }
      return result as unknown as Row;
    }
  };
}

const root = (element: DatumFormBuilderElement): ShadowRoot => element.shadowRoot!;
const banner = (element: DatumFormBuilderElement): HTMLElement | null => root(element).querySelector<HTMLElement>("[data-agent-banner]");
const bannerText = (element: DatumFormBuilderElement): string | undefined => banner(element)?.querySelector("[data-agent-banner-text]")?.textContent ?? undefined;
const notice = (element: DatumFormBuilderElement): HTMLElement | null => root(element).querySelector<HTMLElement>("[data-agent-notice]");
const live = (element: DatumFormBuilderElement): HTMLElement | null => root(element).querySelector<HTMLElement>("[data-agent-live]");
const agentAbortOf = (element: HTMLElement): unknown => (element as unknown as { agentAbort?: unknown }).agentAbort;

interface Canvas extends HTMLElement {
  previewing: boolean;
  previewRoot(): ShadowRoot | undefined;
}
const canvasOf = (element: DatumFormBuilderElement): Canvas => element.builder!.shadowRoot!.querySelector("datum-builder-canvas") as Canvas;
const touched = (element: DatumFormBuilderElement, id: string): boolean =>
  [...(canvasOf(element).previewRoot()?.querySelectorAll<HTMLElement>(`[data-component-id="${id}"]`) ?? [])].some((el) => el.hasAttribute("data-agent-touched"));

const field = (id: string, label = id): Row => ({ type: "text", id, label });

describe("registration on the page", () => {
  it("lists the builder's twenty-four tools and the session pair once beside a <datum-form>, and add_components puts the field on the canvas", async () => {
    const form = document.createElement("datum-form") as DatumFormElement;
    form.setAttribute("features", "all agent");
    form.setAttribute("agent-access", "always");
    form.definition = sampleDefinition();
    document.body.append(form);
    await form.ready;
    const mounted = await mount({ id: "agent-builder-page" });
    await until(() => mounted.toolsEvents.some((detail) => detail.registered && detail.tools.includes("describe_form")));
    const names = mc.names();
    for (const name of [...BUILDER_AGENT_TOOL_NAMES, ...SESSION_TOOL_NAMES]) {
      expect(names.filter((entry) => entry === name)).toHaveLength(1);
    }
    expect(BUILDER_AGENT_TOOL_NAMES).toHaveLength(24);
    expect(names).toContain("describe_form");
    expect(new Set(names).size).toBe(names.length);
    // The builder's twenty-four and the pair beside the form's twelve: one page of thirty-eight names.
    expect(names).toHaveLength(38);

    const entry = (await mc.getTools()).find((tool) => tool.name === "add_components")!;
    const text = await mc.executeTool(entry, { builder: "agent-builder-page", components: [field("agentNote", "Agent note")] });
    const result = JSON.parse(text as string) as Row;
    expect(result).toMatchObject({ ok: true, builder: "agent-builder-page" });
    expect(mounted.element.controller!.snapshot().children?.content?.some((node) => node.id === "agentNote")).toBe(true);
    await until(() => canvasOf(mounted.element).previewRoot()?.querySelector('[data-component-id="agentNote"]'));
    expect(loads.builder).toBe(1);
    expect(loads.form).toBe(1);
  });

  it("a builder-only page lists twenty-six names: the builder's twenty-four and the session pair", async () => {
    const mounted = await mount({ id: "agent-builder-alone" });
    await until(() => mounted.toolsEvents.some((detail) => detail.registered));
    expect(mc.names()).toHaveLength(26);
    expect(new Set(mc.names())).toEqual(new Set([...BUILDER_AGENT_TOOL_NAMES, ...SESSION_TOOL_NAMES]));
  });

  it('features="all" registers nothing and never calls the loader', async () => {
    const mounted = await mount({ features: "all" });
    await settle();
    expect(loads.builder).toBe(0);
    expect(agentAbortOf(mounted.element)).toBeUndefined();
    expect(mc.names()).toEqual([]);
    expect(mounted.toolsEvents).toEqual([]);
    expect(banner(mounted.element)).toBeNull();
    expect(live(mounted.element)).toBeNull();
  });

  it("disconnect withdraws the tools synchronously and aborts the per-connection signal", async () => {
    const mounted = await mount({ id: "agent-builder-leaving" });
    await until(() => mounted.toolsEvents.some((detail) => detail.registered));
    expect(mc.names()).toContain("describe_builder");
    const controller = agentAbortOf(mounted.element) as AbortController;
    expect(controller).toBeInstanceOf(AbortController);
    mounted.element.remove();
    expect(controller.signal.aborted).toBe(true);
    expect(agentAbortOf(mounted.element)).toBeUndefined();
    expect(mc.names()).toEqual([]);
    expect(mounted.toolsEvents.at(-1)).toEqual({ registered: false, tools: [], target: "builder", handle: "agent-builder-leaving", access: "off" });
  });

  it("the engine shell <datum-builder> used bare registers no tool and never loads the agent chunk", async () => {
    const shell = document.createElement(DATUM_BUILDER_TAG_NAME);
    shell.setAttribute("features", "all agent");
    document.body.append(shell);
    await until(() => shell.shadowRoot?.querySelector("datum-builder-canvas"));
    await settle();
    expect(loads.builder).toBe(0);
    expect(loads.form).toBe(0);
    expect(mc.names()).toEqual([]);
    expect(agentRegistrarFor(document).tools()).toEqual([]);
  });
});

describe("open", () => {
  it("switches to a workspace and panel, and reports notDone for a hidden workspace", async () => {
    const mounted = await mount({ "hidden-workspaces": "data" });
    const opened = await mounted.ok("open", { workspace: "logic", panel: "variables" });
    expect(mounted.element.workspace).toBe("logic");
    expect(mounted.element.builder!.panel).toBe("variables");
    expect(opened.shown).toMatchObject({ workspace: "logic", panel: "variables" });
    expect(opened.notDone).toBeUndefined();
    const hidden = await mounted.ok("open", { workspace: "data" });
    expect(hidden.notDone).toEqual([expect.objectContaining({ what: "workspace", reason: "hidden" })]);
    expect(mounted.element.workspace).toBe("logic");
  });

  it("open { panel } from Languages with a typed cell is refused, raises no prompt and stays on Languages", async () => {
    const mounted = await mount();
    await mounted.ok("open", { workspace: "languages" });
    const shell = mounted.element.builder!.shadowRoot!;
    const surface = (): ShadowRoot | null => shell.querySelector("datum-builder-languages")?.shadowRoot ?? null;
    await until(() => surface()?.querySelector("[data-languages-row]"));
    const cellBox = surface()!.querySelector<HTMLInputElement>('input[data-languages-cell="components/country/label"][data-languages-locale="fr-CA"]')!;
    cellBox.focus();
    cellBox.value = "Pays";
    cellBox.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await until(() => (shell.querySelector("datum-builder-languages") as unknown as { pendingCount: number }).pendingCount === 1);

    // Refused before anything is raised: the table is not rebuilt (a rewrite would drop the caret
    // and a composition in the cell) and no modal dialog is opened over it.
    const main = surface()!.querySelector("[data-languages-main]")!;
    const rewrites = vi.fn();
    const watcher = new MutationObserver(rewrites);
    watcher.observe(main, { childList: true, subtree: true });
    const showModal = vi.fn();
    (HTMLDialogElement.prototype as { showModal?: unknown }).showModal = showModal;

    const refusal = await mounted.refused("open", { panel: "outline" });
    await settle();
    expect(watcher.takeRecords()).toHaveLength(0);
    expect(rewrites).not.toHaveBeenCalled();
    expect(showModal).not.toHaveBeenCalled();
    watcher.disconnect();
    delete (HTMLDialogElement.prototype as { showModal?: unknown }).showModal;
    expect(refusal.code).toBeDefined();
    expect(mounted.element.workspace).toBe("languages");
    // The person's own prompt is never raised for the assistant.
    expect(mounted.element.controller!.unsavedChangesPrompt()).toBeUndefined();
    expect(surface()!.querySelector("dialog[data-prompt]")).toBeNull();
  });

  it("canTry: open { tryIt } is not-tryable without the try-it feature and on a workspace without Try it; the mode alone no longer decides", async () => {
    const mounted = await mount();
    const host = elementBuilderHost(mounted.element);
    expect(host.ui!.canTry()).toBe(true);
    // A workspace whose canvas has no Try it.
    await mounted.ok("open", { workspace: "logic" });
    expect(host.ui!.canTry()).toBe(false);
    const onLogic = await mounted.ok("open", { tryIt: true });
    expect(onLogic.notDone).toEqual([expect.objectContaining({ what: "tryIt", reason: "not-tryable" })]);
    await mounted.ok("open", { workspace: "form" });
    expect(host.ui!.canTry()).toBe(true);
    // A designer's tryable canvas is the person's Try it
    // too, so the wrapper's mode alone does not answer false; the shell's own gate
    // (`tryable`) does, as the journeys case below shows on a real Pages view and map.
    Object.defineProperty(mounted.element, "mode", { configurable: true, get: () => "pdf" });
    expect(host.ui!.canTry()).toBe(true);
    delete (mounted.element as unknown as { mode?: unknown }).mode;
    vi.spyOn(mounted.element.builder!, "tryable", "get").mockReturnValue(false);
    expect(host.ui!.canTry()).toBe(false);
    vi.restoreAllMocks();
    // One builder on the page at a time, so no call needs the builder handle.
    mounted.element.remove();

    const minimal = await mount({ features: "minimal agent" });
    expect(minimal.element.featureEnabled("try-it")).toBe(false);
    expect(elementBuilderHost(minimal.element).ui!.canTry()).toBe(false);
    const off = await minimal.ok("open", { tryIt: true });
    expect(off.notDone).toEqual([expect.objectContaining({ what: "tryIt", reason: "not-tryable" })]);
  });
});

describe("the banner, the notice and the live region", () => {
  it("exist once in the wrapper's shadow root, outside the shell, across a features toggle", async () => {
    const mounted = await mount();
    await mounted.ok("add_components", { components: [field("first")] });
    expect(notice(mounted.element)!.hidden).toBe(false);
    mounted.element.features = "all";
    await settle();
    // The withdrawn registration takes its notice and banner down with it.
    expect(notice(mounted.element)!.hidden).toBe(true);
    mounted.element.features = "all agent";
    await mounted.element.agentTools();
    await mounted.ok("add_components", { components: [field("second")] });
    await mounted.ok("begin_session", { purpose: "Again" });
    for (const selector of ["[data-agent-banner]", "[data-agent-notice]", "[data-agent-live]", "style[data-agent-styles]"]) {
      expect(root(mounted.element).querySelectorAll(selector)).toHaveLength(1);
      expect(mounted.element.builder!.shadowRoot!.querySelector(selector)).toBeNull();
    }
    expect(live(mounted.element)!.getAttribute("aria-live")).toBe("polite");
    expect(banner(mounted.element)!.getAttribute("role")).toBe("region");
    expect(banner(mounted.element)!.getAttribute("aria-label")).toBe("Assistant");
    await mounted.ok("end_session", { summary: "Done." });
  });

  it("a write outside a session announces, shows the notice with Undo, and the notice's Undo takes the write back", async () => {
    const mounted = await mount();
    await mounted.ok("add_components", { components: [field("a"), field("b")] });
    expect(live(mounted.element)!.textContent).toBe("Assistant added 2 components");
    expect(notice(mounted.element)!.hidden).toBe(false);
    expect(notice(mounted.element)!.querySelector("[data-agent-notice-text]")!.textContent).toBe("Assistant added 2 components");
    const undo = notice(mounted.element)!.querySelector<HTMLButtonElement>("[data-agent-notice-action]")!;
    expect(undo.textContent).toBe("Undo");
    undo.click();
    expect(mounted.element.controller!.snapshot().children?.content?.some((node) => node.id === "a")).toBe(false);
    expect(notice(mounted.element)!.hidden).toBe(true);
  });

  it("the notice goes after 20 s, and a datum-agent-action for a write carries componentIds and undoSteps", async () => {
    const mounted = await mount();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mounted.ok("add_components", { components: [field("timed")] });
    const action = mounted.actions.find((detail) => detail.tool === "add_components")!;
    expect(action).toMatchObject({ target: "builder", undoSteps: 1, changed: true });
    expect(action.componentIds).toEqual(expect.arrayContaining(["timed"]));
    expect(notice(mounted.element)!.hidden).toBe(false);
    vi.advanceTimersByTime(19_999);
    expect(notice(mounted.element)!.hidden).toBe(false);
    vi.advanceTimersByTime(2);
    expect(notice(mounted.element)!.hidden).toBe(true);
  });

  it("the person's own edit dismisses the notice, and after end_session hides the summary banner", async () => {
    const mounted = await mount();
    const controller = mounted.element.controller!;
    await mounted.ok("add_components", { components: [field("noticed")] });
    expect(notice(mounted.element)!.hidden).toBe(false);
    controller.add("text");
    expect(notice(mounted.element)!.hidden).toBe(true);
    expect(notice(mounted.element)!.childElementCount).toBe(0);

    await mounted.ok("begin_session", { purpose: "Adding fields" });
    await mounted.ok("add_components", { components: [field("inSession")] });
    // Inside a session the banner is the account of the work: no notice row.
    expect(notice(mounted.element)!.hidden).toBe(true);
    await mounted.ok("end_session", { summary: "Added a field." });
    expect(banner(mounted.element)!.hidden).toBe(false);
    expect(bannerText(mounted.element)).toBe("The assistant finished: Added a field.");
    expect(banner(mounted.element)!.querySelector("[data-agent-undo-all]")!.textContent).toBe("Undo all (1)");
    controller.add("text");
    expect(banner(mounted.element)!.hasAttribute("hidden")).toBe(true);
    expect(banner(mounted.element)!.querySelector("button")).toBeNull();
  });

  it("the notice's Undo pressed from the keyboard gives the person's place to the bar's Redo, not the page's body", async () => {
    const mounted = await mount();
    await mounted.ok("add_components", { components: [field("keyed")] });
    const undo = notice(mounted.element)!.querySelector<HTMLButtonElement>("[data-agent-notice-action]")!;
    undo.focus();
    expect(root(mounted.element).activeElement).toBe(undo);
    undo.click();
    expect(mounted.element.controller!.snapshot().children?.content?.some((node) => node.id === "keyed")).toBe(false);
    expect(notice(mounted.element)!.hidden).toBe(true);
    expect(document.activeElement).toBe(mounted.element);
    expect(root(mounted.element).activeElement).toBe(mounted.element.builder);
    expect(mounted.element.builder!.shadowRoot!.activeElement?.hasAttribute("data-redo")).toBe(true);
  });

  it("a dismissed summary banner stays hidden through the person's Undo and Redo; the next session draws it again", async () => {
    const mounted = await mount();
    const controller = mounted.element.controller!;
    await mounted.ok("begin_session", { purpose: "Two fields" });
    await mounted.ok("add_components", { components: [field("d1")] });
    await mounted.ok("add_components", { components: [field("d2")] });
    await mounted.ok("end_session", { summary: "Done." });
    expect(banner(mounted.element)!.querySelector("[data-agent-undo-all]")!.textContent).toBe("Undo all (2)");
    banner(mounted.element)!.querySelector<HTMLButtonElement>("[data-agent-dismiss]")!.click();
    expect(banner(mounted.element)!.hasAttribute("hidden")).toBe(true);
    // The catalogue's count moves with each of these and it draws the banner again: still hidden.
    controller.undo();
    expect(banner(mounted.element)!.hasAttribute("hidden")).toBe(true);
    expect(banner(mounted.element)!.querySelector("button")).toBeNull();
    controller.redo();
    expect(banner(mounted.element)!.hasAttribute("hidden")).toBe(true);
    const stepped = await mounted.ok("history", { action: "undo", beyondOwn: true });
    expect(stepped.done).toBe(1);
    expect(banner(mounted.element)!.hasAttribute("hidden")).toBe(true);
    await mounted.ok("begin_session", { purpose: "Again" });
    expect(banner(mounted.element)!.hidden).toBe(false);
    await mounted.ok("end_session", { summary: "Done again." });
    expect(banner(mounted.element)!.hidden).toBe(false);
    expect(bannerText(mounted.element)).toBe("The assistant finished: Done again.");
  });

  it("Undo all pressed from the keyboard takes the session back and keeps the banner, with focus on Dismiss", async () => {
    const mounted = await mount();
    const controller = mounted.element.controller!;
    await mounted.ok("begin_session", { purpose: "One field" });
    await mounted.ok("add_components", { components: [field("undoneAll")] });
    await mounted.ok("end_session", { summary: "Done." });
    const undoAll = banner(mounted.element)!.querySelector<HTMLButtonElement>("[data-agent-undo-all]")!;
    expect(undoAll.textContent).toBe("Undo all (1)");
    undoAll.focus();
    undoAll.click();
    expect(controller.snapshot().children?.content?.some((node) => node.id === "undoneAll")).toBe(false);
    expect(banner(mounted.element)!.hasAttribute("hidden")).toBe(false);
    expect(bannerText(mounted.element)).toBe("The assistant finished: Done.");
    expect(banner(mounted.element)!.querySelector("[data-agent-undo-all]")).toBeNull();
    expect(root(mounted.element).activeElement?.hasAttribute("data-agent-dismiss")).toBe(true);
    (root(mounted.element).activeElement as HTMLButtonElement).click();
    expect(banner(mounted.element)!.hasAttribute("hidden")).toBe(true);
  });

  it("the line an Undo all press leaves goes with the person's next own edit and with a reseed", async () => {
    const mounted = await mount();
    const controller = mounted.element.controller!;
    const pressUndoAll = async (summary: string): Promise<void> => {
      await mounted.ok("begin_session", { purpose: "One field" });
      await mounted.ok("add_components", { components: [field(`left${summary.length}`)] });
      await mounted.ok("end_session", { summary });
      // A pointer press: focus is not on the banner.
      (document.activeElement as HTMLElement | null)?.blur();
      banner(mounted.element)!.querySelector<HTMLButtonElement>("[data-agent-undo-all]")!.click();
      expect(banner(mounted.element)!.hasAttribute("hidden")).toBe(false);
      expect(bannerText(mounted.element)).toBe(`The assistant finished: ${summary}`);
    };
    await pressUndoAll("Done.");
    // The person's own edit: the line saying the assistant finished (its work already undone) goes.
    controller.add("text");
    expect(banner(mounted.element)!.hasAttribute("hidden")).toBe(true);
    expect(banner(mounted.element)!.querySelector("button")).toBeNull();
    await pressUndoAll("Done again.");
    // A reseed takes it down too.
    mounted.element.definition = { ...sampleDefinition(), id: "reseeded-leftover" };
    await until(() => banner(mounted.element)!.hasAttribute("hidden"));
    expect(banner(mounted.element)!.querySelector("button")).toBeNull();
  });
});

describe("sessions on the builder", () => {
  it("make the shell inert with the banner and Stop, focus on Stop when focus was in the builder; end lifts it", async () => {
    const mounted = await mount();
    // A control the shell draws: the first button in the markup is the phone tier's menu opener, which
    // is display none at this width, and jsdom (since 30) applies the shadow stylesheet and so takes it
    // out of the focusable areas, as a browser does.
    const inspectorInput = mounted.element.builder!.shadowRoot!.querySelector<HTMLElement>("[data-strip] [data-panel]")!;
    inspectorInput.focus();
    expect(mounted.element.builder!.shadowRoot!.activeElement).toBe(inspectorInput);
    expect(root(mounted.element).activeElement).toBe(mounted.element.builder);
    const begun = await mounted.ok("begin_session", { purpose: "Building the form" });
    expect(begun).toMatchObject({ locked: true });
    expect(mounted.element.builder!.hasAttribute("inert")).toBe(true);
    expect(banner(mounted.element)!.hidden).toBe(false);
    expect(bannerText(mounted.element)).toBe("An assistant is working on this form: Building the form");
    const stop = banner(mounted.element)!.querySelector<HTMLButtonElement>("[data-agent-stop]")!;
    expect(stop.textContent).toBe("Stop");
    expect(root(mounted.element).activeElement).toBe(stop);
    expect(live(mounted.element)!.textContent).toBe("An assistant started working on this form: Building the form. Press Stop to take over.");
    await mounted.ok("end_session", { summary: "Done." });
    expect(mounted.element.builder!.hasAttribute("inert")).toBe(false);
  });

  it("leaves focus in a page input outside the builder", async () => {
    const mounted = await mount();
    const chat = document.createElement("input");
    document.body.append(chat);
    chat.focus();
    await mounted.ok("begin_session", { purpose: "Building" });
    expect(mounted.element.builder!.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(chat);
    await mounted.ok("end_session", { summary: "Done." });
  });

  it("moves focus to Stop from a page control slotted into the shell's toolbar (inert blurs it through the flat tree)", async () => {
    const mounted = await mount();
    const ask = document.createElement("button");
    ask.slot = "toolbar";
    ask.textContent = "Ask the assistant";
    mounted.element.append(ask);
    ask.focus();
    expect(document.activeElement).toBe(ask);
    expect(root(mounted.element).activeElement).toBeNull();
    await mounted.ok("begin_session", { purpose: "From the toolbar" });
    expect(root(mounted.element).activeElement?.hasAttribute("data-agent-stop")).toBe(true);
    await mounted.ok("end_session", { summary: "Done." });
  });

  it("a resumed begin_session redraws the banner with the new purpose, announces nothing new and leaves focus on Stop", async () => {
    const mounted = await mount();
    await mounted.ok("begin_session", { purpose: "First purpose" });
    expect(root(mounted.element).activeElement?.hasAttribute("data-agent-stop")).toBe(true);
    const said = live(mounted.element)!.textContent;
    const again = await mounted.ok("begin_session", { purpose: "Second purpose" });
    expect(again.resumed).toBe(true);
    expect(bannerText(mounted.element)).toBe("An assistant is working on this form: Second purpose");
    expect(live(mounted.element)!.textContent).toBe(said);
    expect(banner(mounted.element)!.querySelectorAll("[data-agent-stop]")).toHaveLength(1);
    expect(root(mounted.element).activeElement).toBe(banner(mounted.element)!.querySelector("[data-agent-stop]"));
    // Focus put back on the page's body: a resumed begin leaves it there (only the first begin moves it).
    banner(mounted.element)!.querySelector<HTMLButtonElement>("[data-agent-stop]")!.blur();
    expect(root(mounted.element).activeElement).toBeNull();
    await mounted.ok("begin_session", { purpose: "Third purpose" });
    expect(bannerText(mounted.element)).toBe("An assistant is working on this form: Third purpose");
    expect(root(mounted.element).activeElement).toBeNull();
    expect(live(mounted.element)!.textContent).toBe(said);
    await mounted.ok("end_session", { summary: "Done." });
  });

  it("Stop undoes the session's three writes and shows Allow again, which clears the latch", async () => {
    const mounted = await mount();
    const controller = mounted.element.controller!;
    const before = JSON.stringify(controller.snapshot());
    await mounted.ok("begin_session", { purpose: "Three fields" });
    await mounted.ok("add_components", { components: [field("one")] });
    await mounted.ok("add_components", { components: [field("two")] });
    await mounted.ok("add_components", { components: [field("three")] });
    banner(mounted.element)!.querySelector<HTMLButtonElement>("[data-agent-stop]")!.click();
    await until(() => bannerText(mounted.element) === "The assistant was stopped; 3 changes were undone");
    expect(JSON.stringify(controller.snapshot())).toBe(before);
    expect(mounted.element.builder!.hasAttribute("inert")).toBe(false);
    const allow = banner(mounted.element)!.querySelector<HTMLButtonElement>("[data-agent-allow-again]")!;
    expect(allow.textContent).toBe("Allow the assistant again");
    expect(live(mounted.element)!.textContent).toBe("The assistant was stopped; 3 changes were undone");
    const held = await mounted.refused("add_components", { components: [field("four")] });
    expect(held.code).toBe("stopped");
    const read = await mounted.ok("describe_builder", {});
    expect(read.stopped).toBe(true);
    allow.click();
    expect(banner(mounted.element)!.hidden).toBe(true);
    await mounted.ok("add_components", { components: [field("four")] });
    expect(mounted.sessions.map((detail) => detail.phase)).toEqual(["begin", "stop", "allow-again"]);
  });
});

describe("visibility of writes", () => {
  it("outlines the written component in the canvas preview root with data-agent-touched for 1 500 ms", async () => {
    const mounted = await mount();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const shell = mounted.element.builder!;
    const highlight = shell.highlightComponents.bind(shell);
    let calledAt = 0;
    vi.spyOn(shell, "highlightComponents").mockImplementation((ids, ms) => {
      calledAt = Date.now();
      highlight(ids, ms);
    });
    await mounted.ok("set_properties", { edits: [{ componentId: "fullName", propertyPath: "label", value: "Your name" }] });
    expect(shell.highlightComponents).toHaveBeenCalledWith(["fullName"], 1_500);
    expect(touched(mounted.element, "fullName")).toBe(true);
    // Timed from the call (the fake clock also follows real time while the test awaits).
    vi.advanceTimersByTime(Math.max(0, 1_400 - (Date.now() - calledAt)));
    expect(touched(mounted.element, "fullName")).toBe(true);
    vi.advanceTimersByTime(200);
    expect(touched(mounted.element, "fullName")).toBe(false);
  });

  it("no reveal, highlight or focus change while an inspector text box has focus; the announcement still happens", async () => {
    const mounted = await mount();
    await mounted.ok("open", { componentId: "fullName" });
    let box: HTMLElement | undefined;
    // A text box of the inspector (datum-builder-properties) for the selected field.
    await until(() => {
      const inspector = deepAll(mounted.element.builder!.shadowRoot!, "datum-builder-properties")[0];
      box = inspector
        ? ([...deepAll(inspector.shadowRoot ?? inspector, "textarea, input")].find(
            (el) => el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && ["text", ""].includes(el.type))
          ) as HTMLElement | undefined)
        : undefined;
      return box;
    });
    box!.focus();
    expect(elementBuilderHost(mounted.element).ui!.focusInTextControl()).toBe(true);
    const reveal = vi.spyOn(mounted.element.builder!, "revealComponent");
    const highlight = vi.spyOn(mounted.element.builder!, "highlightComponents");
    await mounted.ok("set_properties", { edits: [{ componentId: "fullName", propertyPath: "description", value: "As on your passport" }] });
    expect(reveal).not.toHaveBeenCalled();
    expect(highlight).not.toHaveBeenCalled();
    // The inspector repaints the selected field's boxes after the write and keeps the person's place
    // on the same box (its own repaint rule); nothing of the agent's moved it elsewhere.
    expect(deepActive(mounted.element)?.id).toBe(box!.id);
    expect(elementBuilderHost(mounted.element).ui!.focusInTextControl()).toBe(true);
    expect(live(mounted.element)!.textContent).toContain("Assistant changed");
  });
});

describe("features and reseeds", () => {
  it("an agent-only features toggle keeps undo history, the selection and a draft, and the inner builder reads all agent", async () => {
    const mounted = await mount({ features: "all" });
    const controller = mounted.element.controller!;
    controller.add("text");
    const selected = controller.selectedComponentId();
    expect(selected).toBeDefined();
    controller.setDraftProperty(selected!, "label", "Typed but not applied");
    expect(controller.canUndo()).toBe(true);
    mounted.element.features = "all agent";
    await mounted.element.agentTools();
    expect(mounted.element.controller).toBe(controller);
    expect(controller.canUndo()).toBe(true);
    expect(controller.selectedComponentId()).toBe(selected);
    expect(controller.hasPendingChanges(selected)).toBe(true);
    expect(mounted.element.builder!.features).toBe("all agent");
    expect(mounted.element.builder!.featureEnabled("agent")).toBe(true);
    mounted.element.features = "all";
    await settle();
    expect(mounted.element.builder!.features).toBe("all");
    expect(controller.canUndo()).toBe(true);
    expect(controller.hasPendingChanges(selected)).toBe(true);
  });

  it("order (i): the chunk lands after the shell seeded; the next definition assignment ends an open session as rebuilt and bumps the revision", async () => {
    const mounted = await mount();
    expect(mounted.element.agentBuildState).toBe("ready");
    const first = await mounted.ok("describe_builder", {});
    await mounted.ok("begin_session", { purpose: "Before the reseed" });
    mounted.element.definition = { ...sampleDefinition(), id: "reseeded" };
    await until(() => mounted.sessions.some((detail) => detail.phase === "end"));
    expect(mounted.sessions.find((detail) => detail.phase === "end")).toMatchObject({ reason: "rebuilt" });
    expect(mounted.element.builder!.hasAttribute("inert")).toBe(false);
    const after = await mounted.ok("describe_builder", {});
    expect(after.revision as number).toBeGreaterThan(first.revision as number);
    expect(after.session).toBeFalsy();
  });

  it("order (ii): attached while the builder still loads, the seeding init is not a reseed; the next one is", async () => {
    // A synthetic window: on a real page the element seeds its shell synchronously in
    // connectedCallback, before the chunk can land, so "loading" at attach exists only inside a
    // reseed's held init; the test attaches directly from there. The element's own attachment
    // never lands, so the direct attach below is the page's only builder.
    loads.hold = true;
    const mounted = await mount({ id: "agent-order-two" });
    expect(loads.builder).toBe(1);
    const element = mounted.element;
    // Counts the reseed calls the attachment makes on its registration.
    const registrar = agentRegistrarFor(document);
    const register = registrar.registerBuilder.bind(registrar);
    let replaced = 0;
    vi.spyOn(registrar, "registerBuilder").mockImplementation((entry) => {
      const registration = register(entry);
      const real = registration.runtimeReplaced;
      registration.runtimeReplaced = () => {
        replaced += 1;
        real();
      };
      return registration;
    });
    let attachment: ReturnType<typeof attachBuilderAgent> | undefined;
    let stateAtAttach: string | undefined;
    const signal = new AbortController();
    // Withdrawn however the test ends: a registration left on the page registrar would put a
    // second builder under every later test in the file.
    try {
      // Inside a reseed the wrapper holds the builder's init until every side is on the new form:
      // agentBuildState reads "loading" there, the one window a connected builder is not ready in.
      element.builder!.addEventListener("builder-change", (event) => {
        if ((event as CustomEvent<{ reason: string }>).detail.reason === "init" && attachment === undefined) {
          stateAtAttach = element.agentBuildState;
          attachment = attachBuilderAgent(element, signal.signal);
        }
      });
      element.definition = { ...sampleDefinition(), id: "seeding" };
      await until(() => attachment !== undefined && element.agentBuildState === "ready");
      await settle();
      expect(stateAtAttach).toBe("loading");
      // The held init reached the attachment as its first: it made the builder ready, nothing more.
      expect(replaced).toBe(0);
      const registration = attachment!.registration;
      const seeded = registration.revision();
      expect(mounted.sessions.filter((detail) => detail.reason === "rebuilt")).toEqual([]);
      okOf("begin_session", await attachment!.execute("begin_session", { purpose: "After the seed" }));
      expect(element.builder!.hasAttribute("inert")).toBe(true);
      element.definition = { ...sampleDefinition(), id: "reseeded-again" };
      await until(() => mounted.sessions.some((detail) => detail.reason === "rebuilt"));
      expect(replaced).toBe(1);
      expect(registration.revision()).toBeGreaterThan(seeded);
      expect(element.builder!.hasAttribute("inert")).toBe(false);
    } finally {
      signal.abort();
    }
  });
});

describe("the pdfFindings gate", () => {
  it("answers undefined without pdf in the definition and with the pdf feature off, and the wrapper's array with both", async () => {
    const plain = await mount({ features: "all agent" });
    expect(elementBuilderHost(plain.element).ui!.pdfFindings!()).toBeUndefined();

    // One generated layout whose condition names a field the form lacks: a finding about the layout.
    const withPdf = {
      ...sampleDefinition(),
      pdf: {
        layouts: [
          {
            id: "letter",
            kind: "generated",
            name: "Letter",
            when: "missingField = \"x\"",
            root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [], header: [], footer: [] } }
          }
        ]
      }
    } as unknown as FormDefinition;
    const featureOff = await mount({ features: "logic agent" }, withPdf);
    expect(featureOff.element.definition.pdf).toBeDefined();
    expect(featureOff.element.featureEnabled("pdf")).toBe(false);
    expect(elementBuilderHost(featureOff.element).ui!.pdfFindings!()).toBeUndefined();

    const both = await mount({ features: "all agent" }, withPdf);
    const definition = both.element.definition;
    const findings = elementBuilderHost(both.element).ui!.pdfFindings!();
    expect(findings).toEqual(pdfLayoutConditionFindings({ formRoot: definition.root, locale: definition.localization?.defaultLocale ?? "en" }, definition.pdf!));
    expect(Array.isArray(findings)).toBe(true);
  });
});

// ---- the page's seams ----

/** The body module `try_it` loads, as the engine's `tools.ts` imports it (the recipe below). */
const TRY_BODY = "../../../engine/form-engine/agent/builder/agentpart-try.ts";

/** Two journeys over the sample form: `intake` across two pages, `quick` on one. */
function withJourneys(): FormDefinition {
  return {
    ...sampleDefinition(),
    journey: {
      journeys: [
        {
          id: "intake",
          name: "Intake",
          pages: [
            { id: "about", title: "About you", components: ["fullName"] },
            { id: "contact", title: "Keeping in touch", components: ["subscribe"] }
          ]
        },
        { id: "quick", name: "Quick", pages: [{ id: "all", components: ["fullName", "country", "subscribe", "email"] }] }
      ],
      defaultJourneyId: "intake"
    }
  } as unknown as FormDefinition;
}

/** The sample form with one generated PDF layout beside its journeys. */
function withJourneysAndPdf(): FormDefinition {
  return {
    ...withJourneys(),
    pdf: {
      layouts: [{ id: "letter", kind: "generated", name: "Letter", root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [], header: [], footer: [] } } }]
    }
  } as unknown as FormDefinition;
}

/** Waits for each side that is on to have its mode registered (their chunks). */
async function sidesReady(element: DatumFormBuilderElement): Promise<void> {
  await until(
    () =>
      (element.pdf === "off" || element.hiddenWorkspaces.includes("pdf") || element.pdfMode !== undefined) &&
      (element.journeys === "off" || element.hiddenWorkspaces.includes("journeys") || element.journeyMode !== undefined)
  );
}

interface TryCanvas extends Canvas {
  tryChunkState(): "ready" | "loading" | "failed" | "off";
}

describe("body chunks load through the element", () => {
  it("a forced rejection of the try_it body answers retryable chunk-unavailable, and the next call loads it", async () => {
    // The recipe, independent of file order: the body is loaded here first, so the module
    // graph already holds it, and only vi.resetModules() before the doMock makes the next load go
    // through the mock. The body's memo lives in each registration's lazyTool (tools.ts), and the
    // element class is registered once per page (customElements.define), so a fresh mount after
    // the reset is the fresh import: its registration loads the body anew.
    const warm = await mount();
    const warmed = await warm.element.executeAgentTool("try_it", { action: "read" });
    expect(warmed.ok ? "ok" : (warmed as unknown as Row).code).not.toBe("chunk-unavailable");
    warm.element.remove();
    await settle();
    vi.resetModules();
    vi.doMock(TRY_BODY, () => {
      throw new Error("chunk missing");
    });
    const mounted = await mount();
    try {
      const refused = await mounted.refused("try_it", { action: "read" });
      expect(refused).toMatchObject({ code: "chunk-unavailable", retryable: true, details: { what: "agent-try", state: "failed" } });
    } finally {
      vi.doUnmock(TRY_BODY);
    }
    // The rejected load was forgotten: the body loads now and answers for itself.
    const result = await mounted.element.executeAgentTool("try_it", { action: "read" });
    expect(result.ok ? "ok" : (result as unknown as Row).code).not.toBe("chunk-unavailable");
  });
});

describe("Try it and the designers on the page", () => {
  it("canTry is true on an open journey's Step view and false on its map, which it opens on (the shell's gate, not the mode)", async () => {
    const mounted = await mount({ journeys: "on" }, withJourneys());
    await sidesReady(mounted.element);
    const host = elementBuilderHost(mounted.element);
    mounted.element.mode = "journeys";
    await until(() => mounted.element.builder!.mode === "journeys" && mounted.element.journeyMode?.ready === true);
    // A journey opens on its map, which has no Try it; its Step view has.
    expect(mounted.element.journeyMode!.view).toBe("map");
    await until(() => !host.ui!.canTry());
    mounted.element.journeyMode!.view = "step";
    await until(() => host.ui!.canTry());
    expect(mounted.element.mode).toBe("journeys");
    expect(host.ui!.tryIt!()!.tryable()).toBe(true);
    // where() names the journey on the page: the tools' answers say which journey Try it runs.
    const open = mounted.element.journeyMode!.journeyId;
    expect(open).toBe("intake");
    expect(host.ui!.tryIt!()!.where()).toEqual({ workspace: "journeys", journeyId: open });
    mounted.element.journeyMode!.view = "map";
    await until(() => !host.ui!.canTry());
    expect(host.ui!.tryIt!()!.tryable()).toBe(false);
    mounted.element.journeyMode!.view = "step";
    await until(() => host.ui!.canTry());
  });

  it("the Try it adapter answers from the canvas: where, typed answers, the chunk's state and describe_builder.tryIt.chunk", async () => {
    const mounted = await mount();
    const host = elementBuilderHost(mounted.element);
    const adapter = host.ui!.tryIt!()!;
    expect(adapter).toBeDefined();
    expect(adapter.where()).toEqual({ workspace: "form" });
    expect(adapter.trying()).toBe(false);
    expect(adapter.runtime()).toBeUndefined();
    expect(adapter.typed()).toEqual({ values: {}, dirty: new Set() });
    // A canvas that has not asked for the chunk yet answers ready.
    expect(adapter.chunk()).toBe("ready");
    const canvas = canvasOf(mounted.element) as TryCanvas;
    const state = vi.spyOn(canvas, "tryChunkState").mockReturnValue("failed");
    expect(adapter.chunk()).toBe("failed");
    expect(((await mounted.ok("describe_builder", {})).tryIt as Row).chunk).toBe("failed");
    state.mockReturnValue("loading");
    expect(((await mounted.ok("describe_builder", {})).tryIt as Row).chunk).toBe("loading");
    state.mockRestore();
    expect(adapter.start()).toBe(true);
    await adapter.ready();
    expect(adapter.trying()).toBe(true);
    const runtime = adapter.runtime();
    expect(runtime).toBeDefined();
    runtime!.setValue("fullName", "Ada Lovelace");
    expect(adapter.typed().values.fullName).toBe("Ada Lovelace");
    // The answers marked dirty are what triedSplit counts as the person's: typed()
    // copies the tried runtime's set, never an empty one.
    expect(adapter.typed().dirty.has("fullName")).toBe(true);
    expect(adapter.typed().dirty).toEqual(new Set(runtime!.state().dirty));
    adapter.clear();
    expect(adapter.typed().values.fullName ?? "").toBe("");
  });

  it("builds the designer adapters from wrapper.journeyMode and wrapper.pdfMode, 1:1", async () => {
    const mounted = await mount({ journeys: "on", pdf: "on" }, withJourneysAndPdf());
    await sidesReady(mounted.element);
    const host = elementBuilderHost(mounted.element);
    const journeys = host.ui!.journeys!();
    const pdf = host.ui!.pdfLayouts!();
    expect(journeys.state).toBe("ready");
    expect(pdf.state).toBe("ready");
    if (journeys.state !== "ready" || pdf.state !== "ready") {
      return;
    }
    const journeyMode = mounted.element.journeyMode!;
    const pdfMode = mounted.element.pdfMode!;
    expect(journeys.workspace()).toBe("journeys");
    expect(pdf.workspace()).toBe("pdf");
    expect(journeys.actions.list()).toEqual(journeyMode.documents!.list());
    expect(journeys.actions.journeys()).toEqual(journeyMode.journeys);
    expect(journeys.actions.configuration()).toBe(journeyMode.journeyConfiguration);
    expect(pdf.actions.layouts()).toEqual(pdfMode.layouts);
    expect(pdf.actions.configuration()).toBe(pdfMode.pdfConfiguration);
    expect(journeys.openId()).toBe(journeyMode.journeyId);
    expect(pdf.openId()).toBe(pdfMode.layoutId);
    const rename = vi.spyOn(journeyMode, "renameJourney");
    journeys.actions.rename("quick", "Quick one");
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith("quick", "Quick one");
    expect(journeyMode.journeys.find((journey) => journey.id === "quick")?.name).toBe("Quick one");
  });

  it("agentModeState: off, hidden, ready, failed, and none read as loading", async () => {
    const off = await mount({}, withJourneysAndPdf());
    expect(off.element.agentModeState).toEqual({ journeys: "off", pdf: "off" });
    expect(elementBuilderHost(off.element).ui!.pdfLayouts!()).toEqual({ state: "off" });
    off.element.remove();

    const mounted = await mount({ journeys: "on", pdf: "on" }, withJourneysAndPdf());
    await sidesReady(mounted.element);
    const element = mounted.element;
    const host = elementBuilderHost(element);
    expect(element.agentModeState).toEqual({ journeys: "ready", pdf: "ready" });
    const load = vi.spyOn(element as unknown as { modeLoadState(side: string): string }, "modeLoadState");
    load.mockReturnValue("none");
    expect(element.agentModeState).toEqual({ journeys: "loading", pdf: "loading" });
    expect(host.ui!.journeys!()).toEqual({ state: "loading" });
    load.mockReturnValue("failed");
    expect(element.agentModeState).toEqual({ journeys: "failed", pdf: "failed" });
    expect(host.ui!.pdfLayouts!()).toEqual({ state: "failed" });
    load.mockRestore();
    element.hiddenWorkspaces = ["pdf"];
    expect(element.agentModeState).toEqual({ journeys: "ready", pdf: "hidden" });
    expect(host.ui!.pdfLayouts!()).toEqual({ state: "hidden" });
  });

  it("selectDocument opens through the shell's selectDocument and resolves on builder-document-change; already open answers at once", async () => {
    const mounted = await mount({ journeys: "on" }, withJourneys());
    await sidesReady(mounted.element);
    const shell = mounted.element.builder!;
    const host = elementBuilderHost(mounted.element);
    const select = vi.spyOn(shell, "selectDocument");
    const outcome = await host.ui!.selectDocument!("journeys", "quick");
    expect(outcome).toEqual({ status: "opened" });
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith("journeys", "quick");
    expect(shell.mode).toBe("journeys");
    expect(mounted.element.journeyMode!.journeyId).toBe("quick");
    expect(await host.ui!.selectDocument!("journeys", "quick")).toEqual({ status: "opened" });
    expect(select).toHaveBeenCalledTimes(1);
    // Within Journeys the shell moves to the other journey (moveToDocument) and emits only
    // builder-document-change. The mode's select is held a moment here, as a layout's opening
    // is while its template loads, so the journey is not up yet when the shell's selectDocument
    // returns: this answer rests on the builder-document-change listener alone.
    const documents = mounted.element.journeyMode!.documents!;
    const selectNow = documents.select.bind(documents);
    vi.spyOn(documents, "select").mockImplementation(async (id: string) => {
      await settle();
      return selectNow(id);
    });
    const modeChanges: Event[] = [];
    shell.addEventListener("builder-mode-change", (event) => modeChanges.push(event));
    const moving = host.ui!.selectDocument!("journeys", "intake");
    expect(mounted.element.journeyMode!.journeyId).toBe("quick");
    expect(await moving).toEqual({ status: "opened" });
    expect(select).toHaveBeenCalledTimes(2);
    expect(modeChanges).toHaveLength(0);
    expect(mounted.element.journeyMode!.journeyId).toBe("intake");
  });

  it("selectDocument answers failed on the side's builder-mode-error, timeout after 10 s, and failed without a prompt while a draft holds the page", async () => {
    const mounted = await mount({ journeys: "on" }, withJourneys());
    await sidesReady(mounted.element);
    const shell = mounted.element.builder!;
    const host = elementBuilderHost(mounted.element);
    const select = vi.spyOn(shell, "selectDocument").mockReturnValue(true);
    const failing = host.ui!.selectDocument!("journeys", "quick");
    // Another side's error is not this wait's.
    shell.dispatchEvent(new CustomEvent("builder-mode-error", { detail: { mode: "pdf", error: new Error("not this one") } }));
    shell.dispatchEvent(new CustomEvent("builder-mode-error", { detail: { mode: "journeys", error: new Error("chunk missing") } }));
    expect(await failing).toEqual({ status: "failed", message: "chunk missing" });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const waiting = host.ui!.selectDocument!("journeys", "intake");
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });
    vi.advanceTimersByTime(9_999);
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(2);
    expect(await waiting).toEqual({ status: "timeout" });
    vi.useRealTimers();

    select.mockClear();
    const controller = mounted.element.controller!;
    controller.add("text");
    controller.setDraftProperty(controller.selectedComponentId()!, "label", "Typed but not applied");
    const held = await host.ui!.selectDocument!("journeys", "quick");
    expect(held.status).toBe("failed");
    expect(select).not.toHaveBeenCalled();
    expect(controller.unsavedChangesPrompt()).toBeUndefined();
    controller.discardDraft();
    expect(controller.hasPendingChanges(controller.selectedComponentId()!)).toBe(false);

    // A leave guard holding edits (a Logic rule, a template mapping) holds the page the same way.
    let pending = true;
    controller.setLeaveGuard({ pending: () => pending, subject: () => ({ id: "rule-1", label: "Rule", blocked: false }), save: () => true, discard: () => undefined });
    expect((await host.ui!.selectDocument!("journeys", "quick")).status).toBe("failed");
    expect(select).not.toHaveBeenCalled();
    pending = false;
    controller.setLeaveGuard(undefined);

    // A prompt already up for the person: the waiter does not raise a second one through the shell.
    const prompt = vi.spyOn(controller, "unsavedChangesPrompt").mockReturnValue({ componentId: controller.rootId(), action: "panel" });
    expect((await host.ui!.selectDocument!("journeys", "quick")).status).toBe("failed");
    expect(select).not.toHaveBeenCalled();
    prompt.mockRestore();

    // Held after the pre-check (a draft appearing between it and the shell's own requestLeave):
    // the shell's selectDocument answers false and the waiter answers failed at once, not after 10 s.
    select.mockReturnValueOnce(false);
    const raced = host.ui!.selectDocument!("journeys", "quick");
    const answered = await Promise.race([raced, new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 200))]);
    expect(select).toHaveBeenCalledTimes(1);
    expect(answered).toEqual({ status: "failed", message: "Edits the person has not applied hold the page where it is." });
  });

  it("pdfTemplates lists the site's templates in the PDF designer's words, [] without a list, and gives up after 5 s", async () => {
    const mounted = await mount();
    const host = elementBuilderHost(mounted.element);
    expect(await host.ui!.pdfTemplates!()).toEqual([]);
    const source = { storage: "base64", name: "claim.pdf", type: "application/pdf", size: 3, data: "AAA=" } as const;
    mounted.element.pdfTemplates = {
      resolve: async () => new Uint8Array(),
      list: async () => [{ id: "claim", label: { default: "Claim", locales: { fr: "Demande" } }, source }]
    };
    expect(await host.ui!.pdfTemplates!()).toEqual([{ templateId: "claim", label: "Claim", source }]);
    // The Add menu resolves its labels in the PDF mode's locale (the host's locale, else the form's
    // default) from the option's own locales, not in the builder chrome's text locale. The label is
    // host data, so the host's catalog does not word it.
    mounted.element.textLocale = "fr";
    expect(await host.ui!.pdfTemplates!()).toEqual([{ templateId: "claim", label: "Claim", source }]);
    mounted.element.locale = "fr";
    expect(await host.ui!.pdfTemplates!()).toEqual([{ templateId: "claim", label: "Demande", source }]);
    mounted.element.locale = undefined;
    mounted.element.textLocale = undefined;
    const french = await mount({}, { ...sampleDefinition(), localization: { defaultLocale: "fr", supportedLocales: [{ code: "fr" }, { code: "en" }] } } as FormDefinition);
    french.element.pdfTemplates = {
      resolve: async () => new Uint8Array(),
      list: async () => [{ id: "claim", label: { default: "Claim", locales: { fr: "Demande" } }, source }]
    };
    expect(await elementBuilderHost(french.element).ui!.pdfTemplates!()).toEqual([{ templateId: "claim", label: "Demande", source }]);
    mounted.element.pdfTemplates = { resolve: async () => new Uint8Array(), list: () => new Promise(() => undefined) };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const slow = host.ui!.pdfTemplates!();
    const caught = slow.catch((error: unknown) => error);
    vi.advanceTimersByTime(5_001);
    expect(await caught).toBeInstanceOf(Error);
  });

  it("the PDF previews' runtimes: agentSampleRuntime without tried answers, agentTriedRuntime with them", async () => {
    const mounted = await mount();
    const host = elementBuilderHost(mounted.element);
    expect(host.ui!.triedRuntimeForPdf!()).toBeUndefined();
    const sample = host.ui!.hostRuntimeForPdf!();
    expect(sample.formRoot().id).toBe(mounted.element.definition.root.id);
    vi.spyOn(mounted.element, "triedAnswers").mockReturnValue({ fullName: "Ada" });
    const tried = host.ui!.triedRuntimeForPdf!();
    expect(tried?.state().values.fullName).toBe("Ada");
    expect(mounted.element.agentTriedRuntime()?.state().values.fullName).toBe("Ada");
  });
});

describe("the shell's seams on the page", () => {
  it("activeController, leaveGuardSubject, managedSettings and setPreviewLocale reach the shell", async () => {
    const mounted = await mount({ "managed-settings": "identity" });
    const shell = mounted.element.builder!;
    const host = elementBuilderHost(mounted.element);
    expect(host.ui!.activeController!()).toBe(shell.activeController);
    expect(host.ui!.leaveGuardSubject!()).toBe(shell.activeController.leaveGuardSubject());
    expect(host.ui!.managedSettings!()).toEqual(shell.managedSettings);
    expect(host.ui!.managedSettings!()).toContain("identity");
    const locale = vi.spyOn(shell, "setPreviewLocale");
    host.ui!.setPreviewLocale!("fr");
    expect(locale).toHaveBeenCalledWith("fr");
  });

  it("activeController and leaveGuardSubject follow the designer on the page, not the form's controller", async () => {
    const mounted = await mount({ journeys: "on" }, withJourneys());
    await sidesReady(mounted.element);
    const shell = mounted.element.builder!;
    const host = elementBuilderHost(mounted.element);
    expect(await host.ui!.selectDocument!("journeys", "quick")).toEqual({ status: "opened" });
    const designer = host.ui!.activeController!();
    expect(designer).toBe(shell.activeController);
    expect(designer).toBe(mounted.element.journeyMode!.controller);
    expect(designer).not.toBe(mounted.element.controller);
    expect(host.ui!.leaveGuardSubject!()).toBeUndefined();
    // A guard on the designer's controller is the one named; the form's controller holds none.
    designer.setLeaveGuard({ pending: () => true, subject: () => ({ id: "quick-draft", label: "Quick", blocked: false }), save: () => true, discard: () => undefined });
    try {
      expect(host.ui!.leaveGuardSubject!()).toBe("quick-draft");
      expect(mounted.element.controller!.leaveGuardSubject()).toBeUndefined();
    } finally {
      designer.setLeaveGuard(undefined);
    }
  });

  it("languages { list } reads the shell's agentLanguageInputs(), and languagesPending follows agentLanguagesPending()", async () => {
    const mounted = await mount();
    const shell = mounted.element.builder!;
    const inputs = vi.spyOn(shell, "agentLanguageInputs");
    const listed = await mounted.ok("languages", { action: "list" });
    expect(listed.action).toBe("list");
    expect(inputs).toHaveBeenCalled();
    const host = elementBuilderHost(mounted.element);
    expect(host.ui!.languageInputs!()).toEqual(shell.agentLanguageInputs());
    expect(host.ui!.languagesPending!()).toBe(0);
    vi.spyOn(shell, "agentLanguagesPending").mockReturnValue(3);
    expect(host.ui!.languagesPending!()).toBe(3);
  });

  it("setBinding goes through the shell's setBindingForAgent, so the host hears datum-builder-binding-change", async () => {
    bindings.register([
      { id: "agent-test-a", label: "Agent test A", components: {} },
      { id: "agent-test-b", label: "Agent test B", components: {} }
    ]);
    const mounted = await mount();
    const host = elementBuilderHost(mounted.element);
    const controller = mounted.element.controller!;
    const offered = controller.availableBindings().filter((option) => option.id !== controller.bindingId());
    expect(offered.map((option) => option.id)).toEqual(expect.arrayContaining(["agent-test-a", "agent-test-b"]));
    const heard: Array<{ bindingId?: string }> = [];
    mounted.element.addEventListener("datum-builder-binding-change", (event) => heard.push((event as CustomEvent<{ bindingId?: string }>).detail));
    const seam = vi.spyOn(mounted.element.builder!, "setBindingForAgent");
    expect(host.ui!.setBinding!("agent-test-a")).toBe(true);
    expect(seam).toHaveBeenCalledWith("agent-test-a");
    expect(heard.at(-1)?.bindingId).toBe("agent-test-a");
    const count = heard.length;
    expect(host.ui!.setBinding!("no-such-binding")).toBe(false);
    expect(heard).toHaveLength(count);
    // The tool's own route reaches the same seam.
    await mounted.ok("open", { binding: "agent-test-b" });
    expect(heard.at(-1)?.bindingId).toBe("agent-test-b");
  });

  it("save shares the File menu's Saving latch, and the host hears datum-builder-file-action { action: 'save', trigger: 'agent' } once", async () => {
    const mounted = await mount();
    const element = mounted.element;
    const host = elementBuilderHost(element);
    expect(host.ui!.saveAvailable!()).toBeUndefined();
    let release: () => void = () => undefined;
    const contexts: unknown[] = [];
    element.fileActions = {
      save: (context) => {
        contexts.push(context);
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    };
    expect(host.ui!.saveAvailable!()).toEqual({ label: "Save" });
    const fileActions: Row[] = [];
    element.addEventListener("datum-builder-file-action", (event) => fileActions.push((event as CustomEvent<Row>).detail));
    const shellRoot = element.builder!.shadowRoot!;
    const saving = mounted.element.executeAgentTool("save", {});
    const item = (): HTMLButtonElement => shellRoot.querySelector<HTMLButtonElement>("[data-file-save]")!;
    await until(() => item()?.hasAttribute("aria-busy"));
    expect(item().querySelector(".file-item-label")?.textContent).toBe("Saving…");
    // The person's Ctrl+S meanwhile meets the same latch: no second save reaches the host.
    const key = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, composed: true, cancelable: true });
    canvasOf(element).dispatchEvent(key);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ trigger: "agent" });
    release();
    const result = await saving;
    expect(result.ok).toBe(true);
    expect(item().hasAttribute("aria-busy")).toBe(false);
    expect(fileActions.filter((detail) => detail.action === "save")).toHaveLength(1);
    expect(fileActions[0]).toMatchObject({ action: "save", trigger: "agent" });
    expect(fileActions[0]!.definition).toBeDefined();
  });

  it("get_definition { section: 'data-model' } answers the data model on the page: the element host passes loadDataModelKit", async () => {
    const mounted = await mount();
    expect(typeof elementBuilderHost(mounted.element).loadDataModelKit).toBe("function");
    const read = await mounted.ok("get_definition", { section: "data-model" });
    const model = (read.value as Row).dataModel as Row;
    expect(model).toBeDefined();
    expect(model.schema).toBeDefined();
    expect(model.places as number).toBeGreaterThan(0);
  });
});

/** Every element matching `selector` under `start`, through open shadow roots. */
function deepAll(start: ParentNode, selector: string): Element[] {
  const out: Element[] = [...start.querySelectorAll(selector)];
  for (const el of start.querySelectorAll("*")) {
    if (el.shadowRoot) {
      out.push(...deepAll(el.shadowRoot, selector));
    }
  }
  return out;
}

/** The deepest focused element inside the wrapper. */
function deepActive(element: DatumFormBuilderElement): Element | null {
  let active = element.shadowRoot!.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}
