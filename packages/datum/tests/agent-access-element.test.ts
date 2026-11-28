import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The host layer on the element: `agent-access` on `<datum-form>` decides whether the tools the `agent`
 * token loads run. `always` registers them live whatever the definition says; `definition` (the
 * default) lets the form's `root.configuration.agentTools` decide, `"allowed"` live, anything
 * else sealed (`agent-off { by }`, `describe_form`'s minimal result); `never` loads nothing for
 * the element and rejects `agentTools()`. A change never rebuilds the runtime; `datum-agent-tools`
 * carries `access` (and `by` when sealed); an element whose tools were
 * never live adds no `agent` key to a submit or either hook context. The builder registers on its
 * own token whatever any form's access, and reads the author's switch back as
 * `describe_builder.assistants`. jsdom lays nothing out: attributes, events and results only.
 */
const loads = vi.hoisted(() => ({ form: 0, builder: 0 }));
vi.mock("../src/agent-loader.js", async (original) => {
  const real = await original<typeof import("../src/agent-loader.js")>();
  return {
    ...real,
    loadAgent: () => {
      loads.form += 1;
      return real.loadAgent();
    },
    loadBuilderAgent: () => {
      loads.builder += 1;
      return real.loadBuilderAgent();
    }
  };
});

import "../src/form.js";
import "../src/builder.js";
import type { DatumFormElement, DatumFormSubmitDetail } from "../src/form.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { DatumAgentToolsDetail, FormAgentAttachment } from "../src/agent.js";
import { agentRegistrarFor, type AgentToolResult, type BindingState } from "@argusvane/datum-engine/agent";
import { createFakeModelContext } from "@argusvane/datum-engine/testing";
import type { AgentProvenance, FormDefinition, FormPlugin } from "@argusvane/datum-engine";

import { sampleDefinition, until } from "./helpers.js";

type Row = Record<string, unknown>;

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

/*
 * One fake ModelContext for the file, installed before any element mounts (the page registrar
 * keeps the API it first binds to), so `registered` reads true and a sealed form's names can be
 * seen in the browser's list.
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
  loads.form = 0;
  loads.builder = 0;
  process.on("unhandledRejection", onUnhandled);
});

afterEach(async () => {
  document.body.innerHTML = "";
  await settle();
  process.off("unhandledRejection", onUnhandled);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(unhandled).toEqual([]);
});

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

/** The sample form without its data-source select, with the author's switch as given (absent when undefined). */
function formWith(agentTools?: string): FormDefinition {
  const sample = sampleDefinition();
  const content = (sample.root.children?.content ?? []).filter((node) => node.id !== "country");
  const configuration = { ...(sample.root.configuration as Row | undefined), ...(agentTools !== undefined ? { agentTools } : {}) };
  return { ...sample, root: { ...sample.root, configuration, children: { content } } };
}

/** A beforeSubmit and an afterSubmit hook that keep the context's `agent` (or `undefined`). */
function hookSpy(): { plugin: FormPlugin; before: Array<AgentProvenance | undefined>; after: Array<AgentProvenance | undefined> } {
  const before: Array<AgentProvenance | undefined> = [];
  const after: Array<AgentProvenance | undefined> = [];
  const keep = (into: Array<AgentProvenance | undefined>) => (context: { agent?: AgentProvenance }) => {
    into.push(context.agent === undefined ? undefined : structuredClone(context.agent));
  };
  const plugin = { id: "access-provenance-spy", version: "1", hooks: { beforeSubmit: [keep(before)], afterSubmit: [keep(after)] } } as unknown as FormPlugin;
  return { plugin, before, after };
}

interface Mounted {
  element: DatumFormElement;
  errors: Array<{ message: string; cause?: unknown }>;
  toolsEvents: DatumAgentToolsDetail[];
  submits: DatumFormSubmitDetail[];
  execute(name: string, input?: unknown): Promise<AgentToolResult>;
}

/** A `<datum-form features="all agent">` with no `agent-access` unless the attributes give one. */
async function mount(attributes: Record<string, string>, definition: FormDefinition | undefined, setup?: (element: DatumFormElement) => void): Promise<Mounted> {
  const element = document.createElement("datum-form") as DatumFormElement;
  const errors: Mounted["errors"] = [];
  const toolsEvents: DatumAgentToolsDetail[] = [];
  const submits: DatumFormSubmitDetail[] = [];
  element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent).detail));
  element.addEventListener("datum-agent-tools", (event) => toolsEvents.push((event as CustomEvent<DatumAgentToolsDetail>).detail));
  element.addEventListener("datum-submit", (event) => submits.push((event as CustomEvent<DatumFormSubmitDetail>).detail));
  element.setAttribute("features", "all agent");
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  setup?.(element);
  if (definition !== undefined) {
    element.definition = definition;
  }
  document.body.append(element);
  if (definition !== undefined) {
    await element.ready;
  }
  return { element, errors, toolsEvents, submits, execute: (name, input = {}) => element.executeAgentTool(name, input) };
}

function ok(result: AgentToolResult): Row {
  if (!result.ok) {
    throw new Error(`refused: ${result.code}: ${result.message}`);
  }
  return result as unknown as Row;
}

function refused(result: AgentToolResult): Row {
  if (result.ok) {
    throw new Error(`not refused: ${JSON.stringify(result).slice(0, 200)}`);
  }
  return result as unknown as Row;
}

const agentAbortOf = (element: HTMLElement): unknown => (element as unknown as { agentAbort?: unknown }).agentAbort;
const attachmentOf = (element: DatumFormElement): FormAgentAttachment | undefined => (element as unknown as { agentLive?: FormAgentAttachment }).agentLive;
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const AUTHOR_OFF = "This form does not accept assistants: its author turned them off.";
const UNSET_OFF = "This form does not accept assistants: this site lets them fill only forms whose author allowed it, and this form's author has not.";

describe("agent-access on <datum-form>", () => {
  it("absent, over a definition without agentTools: registered sealed by unset; every call but describe_form answers agent-off", async () => {
    const { element, toolsEvents } = await mount({}, formWith());
    expect(element.agentAccess).toBeUndefined();
    expect(element.agentAccessPolicy).toBe("definition");
    await until(() => toolsEvents.some((detail) => detail.registered));
    expect(toolsEvents.at(-1)).toMatchObject({ registered: true, target: "form", access: "sealed", by: "unset" });
    // A sealed form's names are in the browser's list; its calls answer agent-off.
    expect(mc.names()).toContain("set_answers");
    const write = refused(await element.executeAgentTool("set_answers", { answers: { fullName: "Ada" } }));
    expect(write).toMatchObject({ code: "agent-off", retryable: false, message: UNSET_OFF, details: { by: "unset" } });
    expect(element.runtime!.formValues().fullName).not.toBe("Ada");
    const described = ok(await element.executeAgentTool("describe_form", {}));
    expect(described).toMatchObject({ agentAccess: "off", toolset: "datum-form/1" });
    expect(described.guidance as string[]).toHaveLength(1);
    expect(described).not.toHaveProperty("fields");
  });

  it('absent, over agentTools: "allowed": live; describe_form answers agentAccess "on"', async () => {
    const { element, toolsEvents } = await mount({}, formWith("allowed"));
    await until(() => toolsEvents.some((detail) => detail.registered));
    expect(toolsEvents.at(-1)).toEqual(expect.objectContaining({ registered: true, access: "live" }));
    expect(toolsEvents.at(-1)).not.toHaveProperty("by");
    ok(await element.executeAgentTool("set_answers", { answers: { fullName: "Ada" } }));
    expect(element.runtime!.formValues().fullName).toBe("Ada");
    expect(ok(await element.executeAgentTool("describe_form", {})).agentAccess).toBe("on");
  });

  it('definition over agentTools: "off" is sealed by the author; always over the same form runs the tools', async () => {
    const sealed = await mount({ "agent-access": "definition", id: "access-off" }, formWith("off"));
    await until(() => sealed.toolsEvents.some((detail) => detail.registered));
    expect(sealed.toolsEvents.at(-1)).toMatchObject({ access: "sealed", by: "author", handle: "access-off" });
    const refusal = refused(await sealed.execute("begin_session", { purpose: "Fill it" }));
    expect(refusal).toMatchObject({ code: "agent-off", message: AUTHOR_OFF, details: { by: "author" } });
    sealed.element.remove();

    const enforced = await mount({ "agent-access": "always" }, formWith("off"));
    await until(() => enforced.toolsEvents.some((detail) => detail.registered));
    expect(enforced.toolsEvents.at(-1)).toMatchObject({ access: "live" });
    ok(await enforced.execute("set_answers", { answers: { fullName: "Grace" } }));
  });

  it('never: no chunk request, no controller, agentTools() rejects with the never sentence', async () => {
    const { element, toolsEvents } = await mount({ "agent-access": "never" }, formWith("allowed"));
    await settle();
    expect(loads.form).toBe(0);
    expect(agentAbortOf(element)).toBeUndefined();
    expect(toolsEvents).toEqual([]);
    await expect(element.agentTools()).rejects.toThrow('agentTools() is not available: agent-access is "never" on this <datum-form>');
    await expect(element.executeAgentTool("describe_form", {})).rejects.toThrow('executeAgentTool() is not available: agent-access is "never" on this <datum-form>');
    expect(loads.form).toBe(0);
  });

  it("never written after features in markup: an upgraded element requests no chunk and reports nothing", async () => {
    // innerHTML parses the element apart and upgrades it on insertion: every attribute is applied
    // in source order while the element is already connected, `features` (with `agent`) first.
    const host = document.createElement("div");
    document.body.append(host);
    host.innerHTML = '<datum-form features="all agent" agent-access="never"></datum-form>';
    const element = host.firstElementChild as DatumFormElement;
    const errors: unknown[] = [];
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent).detail));
    expect(element.agentAccessPolicy).toBe("never");
    await settle();
    expect(loads.form).toBe(0);
    expect(agentAbortOf(element)).toBeUndefined();
    expect(errors).toEqual([]);
    await expect(element.agentTools()).rejects.toThrow('agentTools() is not available: agent-access is "never" on this <datum-form>');
  });

  it("never set by script right after features on a connected element: no chunk request", async () => {
    const { element } = await mount({ features: "all" }, formWith("allowed"));
    element.features = "all agent";
    element.agentAccess = "never";
    await settle();
    expect(loads.form).toBe(0);
    expect(agentAbortOf(element)).toBeUndefined();
  });

  it("a call waiting on the chunk when never is set rejects with the never sentence", async () => {
    // All in one task, so the call is made before any chunk can have arrived.
    const element = document.createElement("datum-form") as DatumFormElement;
    element.setAttribute("features", "all agent");
    element.definition = formWith("allowed");
    document.body.append(element);
    const waiting = element.agentTools();
    element.agentAccess = "never";
    await expect(waiting).rejects.toThrow('agentTools() is not available: agent-access is "never" on this <datum-form>');
  });

  it("without the agent token it does nothing: the token's own rejection, nothing loaded", async () => {
    const { element } = await mount({ features: "all", "agent-access": "always" }, formWith("allowed"));
    await settle();
    expect(loads.form).toBe(0);
    await expect(element.agentTools()).rejects.toThrow(/does not include "agent"/);
  });

  it("a bad attribute word reports one datum-error and keeps the value; the property throws a TypeError", async () => {
    const { element, errors } = await mount({ "agent-access": "always" }, formWith());
    element.setAttribute("agent-access", "sometimes");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe('agent-access must be "always", "definition" or "never"; got "sometimes"');
    expect(element.agentAccess).toBe("always");
    expect(() => {
      element.agentAccess = "Always" as never;
    }).toThrow(TypeError);
    expect(() => {
      element.agentAccess = "Always" as never;
    }).toThrow('agent-access must be "always", "definition" or "never"; got "Always"');
    expect(element.agentAccess).toBe("always");
    // Removing the attribute is a change to the default.
    element.removeAttribute("agent-access");
    expect(element.agentAccess).toBeUndefined();
    expect(element.agentAccessPolicy).toBe("definition");
  });
});

describe("changing agent-access at run time", () => {
  it('always → definition over an "off" form seals it without unregistering or rebuilding; back to always opens it', async () => {
    const { element, toolsEvents } = await mount({ "agent-access": "always" }, formWith("off"));
    await until(() => toolsEvents.some((detail) => detail.registered));
    const runtime = element.runtime;
    const controller = agentAbortOf(element);
    const attachment = attachmentOf(element)!;
    const unregister = vi.spyOn(attachment.registration, "unregister");
    const revision = attachment.registration.revision();
    expect(toolsEvents.at(-1)).toMatchObject({ access: "live" });

    element.setAttribute("agent-access", "definition");
    await until(() => toolsEvents.at(-1)?.access === "sealed");
    expect(toolsEvents.at(-1)).toMatchObject({ registered: true, access: "sealed", by: "author" });
    expect(element.runtime).toBe(runtime);
    expect(agentAbortOf(element)).toBe(controller);
    expect(attachmentOf(element)).toBe(attachment);
    expect(unregister).not.toHaveBeenCalled();
    expect(attachment.registration.revision()).toBe(revision + 1);
    expect(loads.form).toBe(1);
    expect(refused(await element.executeAgentTool("set_answers", { answers: { fullName: "Ada" } })).code).toBe("agent-off");

    const counted = toolsEvents.length;
    element.agentAccess = "always";
    await until(() => toolsEvents.length > counted);
    expect(toolsEvents.at(-1)).toMatchObject({ registered: true, access: "live" });
    expect(element.runtime).toBe(runtime);
    ok(await element.executeAgentTool("set_answers", { answers: { fullName: "Ada" } }));
  });

  it("always → definition over an allowed form changes nothing and says nothing", async () => {
    const { element, toolsEvents } = await mount({ "agent-access": "always" }, formWith("allowed"));
    await until(() => toolsEvents.some((detail) => detail.registered));
    const revision = attachmentOf(element)!.registration.revision();
    const counted = toolsEvents.length;
    element.agentAccess = "definition";
    await settle();
    expect(toolsEvents).toHaveLength(counted);
    expect(attachmentOf(element)!.registration.revision()).toBe(revision);
  });

  it('definition → never withdraws with access "off" and reason features-changed; never → always registers again', async () => {
    const { element, toolsEvents } = await mount({}, formWith());
    await until(() => toolsEvents.some((detail) => detail.registered));
    const runtime = element.runtime;
    const attachment = attachmentOf(element)!;
    const unregister = vi.spyOn(attachment.registration, "unregister");

    element.agentAccess = "never";
    expect(unregister).toHaveBeenCalledWith("features-changed");
    expect(toolsEvents.at(-1)).toEqual({ registered: false, tools: [], target: "form", handle: attachment.registration.handle, access: "off" });
    expect(agentAbortOf(element)).toBeUndefined();
    expect(mc.names()).toEqual([]);
    await expect(element.agentTools()).rejects.toThrow(/agent-access is "never"/);

    element.setAttribute("agent-access", "always");
    await until(() => toolsEvents.at(-1)?.registered === true);
    expect(toolsEvents.at(-1)).toMatchObject({ access: "live" });
    expect(element.runtime).toBe(runtime);
    expect(loads.form).toBe(2);
    ok(await element.executeAgentTool("set_answers", { answers: { fullName: "Ada" } }));
  });

  it("a definition swap re-reads the new agentTools: unset sealed, then allowed live", async () => {
    const { element, toolsEvents } = await mount({}, formWith());
    await until(() => toolsEvents.some((detail) => detail.registered));
    expect(toolsEvents.at(-1)).toMatchObject({ access: "sealed", by: "unset" });
    element.definition = formWith("allowed");
    await element.ready;
    await until(() => toolsEvents.at(-1)?.access === "live");
    ok(await element.executeAgentTool("set_answers", { answers: { fullName: "Ada" } }));
  });
});

describe("a src form under the definition default", () => {
  it("without the flag: sealed by unset before the definition arrives, and still, unsaid again, once the runtime lands", async () => {
    // The landing's re-read finds the same access: no new datum-agent-tools, no revision move
    // (the first-landing case below pins that the re-read happens).
    let answer: (() => void) | undefined;
    const fetched = new Promise<void>((resolve) => {
      answer = resolve;
    });
    vi.stubGlobal("fetch", async () => {
      await fetched;
      return json(formWith());
    });
    const { element, toolsEvents } = await mount({ src: "/forms/plain.json" }, undefined);
    await until(() => toolsEvents.some((detail) => detail.registered));
    expect(toolsEvents.at(-1)).toMatchObject({ registered: true, access: "sealed", by: "unset" });
    const counted = toolsEvents.length;
    const revision = attachmentOf(element)!.registration.revision();
    answer!();
    await element.ready;
    await settle();
    expect(element.runtime).toBeDefined();
    expect(toolsEvents).toHaveLength(counted);
    expect(attachmentOf(element)!.registration.revision()).toBe(revision);
    expect(attachmentOf(element)!.registration.access()).toEqual({ state: "sealed", by: "unset" });
    expect(refused(await element.executeAgentTool("set_answers", { answers: { fullName: "Ada" } })).code).toBe("agent-off");
  });

  it('with agentTools "allowed" landing after the bind settled: the first landing re-reads access and says live', async () => {
    let answer: (() => void) | undefined;
    const fetched = new Promise<void>((resolve) => {
      answer = resolve;
    });
    vi.stubGlobal("fetch", async () => {
      await fetched;
      return json(formWith("allowed"));
    });
    const { element, toolsEvents } = await mount({ src: "/forms/late.json" }, undefined);
    await until(() => toolsEvents.some((detail) => detail.registered));
    expect(toolsEvents.at(-1)).toMatchObject({ registered: true, access: "sealed", by: "unset" });
    const revision = attachmentOf(element)!.registration.revision();
    answer!();
    await element.ready;
    await until(() => toolsEvents.at(-1)?.access === "live");
    expect(toolsEvents.at(-1)).not.toHaveProperty("by");
    expect(attachmentOf(element)!.registration.revision()).toBe(revision + 1);
    ok(await element.executeAgentTool("set_answers", { answers: { fullName: "Ada" } }));
  });

  it('with agentTools "allowed" landing before bind() settles: an agent write then a submit carry agent with involved: true', async () => {
    // The fetch waits until the chunk has attached, so the registration starts sealed (no runtime yet)
    // and the runtime lands while the browser binding is still held.
    let answer: (() => void) | undefined;
    const fetched = new Promise<void>((resolve) => {
      answer = resolve;
    });
    vi.stubGlobal("fetch", async () => {
      await fetched;
      return json(formWith("allowed"));
    });
    const registrar = agentRegistrarFor(document);
    const realBind = registrar.bind.bind(registrar);
    let releaseBind: (() => void) | undefined;
    const bind = vi.spyOn(registrar, "bind").mockImplementation((api) => {
      const held = new Promise<void>((resolve) => {
        releaseBind = resolve;
      });
      return held.then(() => realBind(api)) as Promise<BindingState>;
    });
    const spy = hookSpy();
    const { element, toolsEvents, submits } = await mount({ src: "/forms/allowed.json" }, undefined, (form) => {
      form.plugins = [spy.plugin];
    });
    await until(() => bind.mock.calls.length > 0);
    expect(attachmentOf(element)!.registration.access()).toEqual({ state: "sealed", by: "unset" });
    answer!();
    await element.ready;
    await until(() => attachmentOf(element)!.registration.access().state === "live");
    // The bind is still held: the attachment has said nothing yet, so only the element's landing
    // can have set the live mark (before any call or submit reads access() again).
    expect(toolsEvents).toEqual([]);
    expect((element as unknown as { agentMarks: { live: boolean } }).agentMarks.live).toBe(true);
    ok(await element.executeAgentTool("set_answers", { answers: { fullName: "Ada Lovelace" } }));
    const detail = await element.submit();
    expect(detail.agent).toMatchObject({ involved: true, paths: ["fullName"], submittedBy: "page" });
    expect(submits.at(-1)!.agent).toEqual(detail.agent);
    expect(spy.before.at(-1)).toMatchObject({ involved: true });
    expect(spy.after.at(-1)).toMatchObject({ involved: true });
    releaseBind!();
    await until(() => toolsEvents.length > 0);
    expect(toolsEvents.at(-1)).toMatchObject({ access: "live" });
  });
});

describe("an element whose tools were never live adds no agent key", () => {
  it("a sealed form's submit has no agent in datum-submit nor in either hook context, after every write was refused", async () => {
    const spy = hookSpy();
    const { element, submits } = await mount({}, formWith("off"), (form) => {
      form.plugins = [spy.plugin];
    });
    // Every tool in the catalogue but describe_form (which answers a sealed form itself) is called
    // once; the gate runs before the schema check, so an empty input meets it too.
    const names = (await element.agentTools()).map((tool) => tool.name).filter((name) => name !== "describe_form");
    for (const name of ["set_answers", "edit_rows", "navigate", "set_locale", "submit", "undo_agent_changes", "drafts", "download_pdf", "begin_session", "end_session"]) {
      expect(names).toContain(name);
    }
    const inputs: Record<string, unknown> = { set_answers: { answers: { fullName: "Ada" } }, begin_session: { purpose: "Fill it" } };
    for (const name of names) {
      expect(refused(await element.executeAgentTool(name, inputs[name] ?? {})), name).toMatchObject({ code: "agent-off" });
    }
    expect(submits).toEqual([]);
    // Nothing reached the journal or the last-writer marks, and the element never marked it live.
    const attachment = attachmentOf(element)!;
    expect(attachment.registration.provenance("page")).toMatchObject({ involved: false, paths: [], tables: [] });
    expect((element as unknown as { agentMarks: { live: boolean; involved: boolean } }).agentMarks).toMatchObject({ live: false, involved: false });
    element.runtime!.setValues({ fullName: "Ada Lovelace" });
    const detail = await element.submit();
    expect(detail.accepted).toBe(true);
    expect("agent" in detail).toBe(false);
    expect("agent" in submits[0]!).toBe(false);
    expect(spy.before).toEqual([undefined]);
    expect(spy.after).toEqual([undefined]);
  });

  it("a form live then sealed keeps agent: the account it had while live", async () => {
    const spy = hookSpy();
    const { element } = await mount({ "agent-access": "always" }, formWith("off"), (form) => {
      form.plugins = [spy.plugin];
    });
    ok(await element.executeAgentTool("set_answers", { answers: { fullName: "Ada Lovelace" } }));
    element.agentAccess = "definition";
    expect(refused(await element.executeAgentTool("set_answers", { answers: { fullName: "Grace" } })).code).toBe("agent-off");
    const detail = await element.submit();
    expect(detail.agent).toMatchObject({ involved: true, paths: ["fullName"], submittedBy: "page" });
    expect(spy.before.at(-1)).toMatchObject({ involved: true });
    expect(spy.after.at(-1)).toMatchObject({ involved: true });
  });

  it("a form live then withdrawn by never keeps agent from the element's marks", async () => {
    const { element } = await mount({ "agent-access": "always" }, formWith());
    ok(await element.executeAgentTool("set_answers", { answers: { fullName: "Ada Lovelace" } }));
    element.agentAccess = "never";
    const detail = await element.submit();
    expect(detail.agent).toMatchObject({ involved: true, complete: false, submittedBy: "page" });
  });
});

describe("the builder beside forms of every access", () => {
  async function mountBuilder(definition: FormDefinition): Promise<{ element: DatumFormBuilderElement; toolsEvents: DatumAgentToolsDetail[] }> {
    const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    const toolsEvents: DatumAgentToolsDetail[] = [];
    element.addEventListener("datum-agent-tools", (event) => toolsEvents.push((event as CustomEvent<DatumAgentToolsDetail>).detail));
    element.setAttribute("features", "all agent -pdf -journeys");
    element.id = "access-builder";
    element.definition = definition;
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    await element.agentTools();
    return { element, toolsEvents };
  }

  /** The Form panel's shadow root, opened first: a panel behind its strip item does not paint. */
  async function formPanel(element: DatumFormBuilderElement): Promise<ShadowRoot> {
    const shell = element.builder!.shadowRoot!;
    const panel = shell.querySelector("datum-builder-form-panel") as HTMLElement;
    if (panel.hidden) {
      shell.querySelector<HTMLElement>('[data-strip] [data-panel="form"]')!.click();
    }
    await until(() => panel.shadowRoot?.querySelector("[data-agent-tools]"));
    return panel.shadowRoot!;
  }

  async function saveRow(element: DatumFormBuilderElement, value: string): Promise<void> {
    const panel = await formPanel(element);
    const select = panel.querySelector<HTMLSelectElement>("[data-agent-tools]")!;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    (await formPanel(element)).querySelector<HTMLElement>("[data-inspector-save]")!.click();
  }

  it("registers live on its own token whatever the forms' access, sealed or never", async () => {
    const sealed = await mount({ id: "access-sealed-form" }, formWith("off"));
    const forbidden = await mount({ id: "access-never-form", "agent-access": "never" }, formWith("allowed"));
    const { element, toolsEvents } = await mountBuilder(sampleDefinition());
    await until(() => toolsEvents.some((detail) => detail.registered));
    expect(toolsEvents.at(-1)).toMatchObject({ registered: true, target: "builder", handle: "access-builder", access: "live" });
    expect(toolsEvents.at(-1)).not.toHaveProperty("by");
    expect(loads.builder).toBe(1);
    const described = ok(await element.executeAgentTool("describe_builder", { builder: "access-builder" }));
    expect(described.builder).toBe("access-builder");
    // The sealed form is still on the page's list; the forbidden one is not.
    const listing = ok(await element.executeAgentTool("describe_form", {}));
    expect(listing).toMatchObject({ form: "access-sealed-form", agentAccess: "off" });
    expect(sealed.element.agentAccessPolicy).toBe("definition");
    expect(forbidden.toolsEvents).toEqual([]);
    // Two forms and a builder: seconds in jsdom, more under load, past vitest's default 5 s.
  }, 15_000);

  it("describe_builder.assistants reads the saved row: unset, allowed, off, and unset again", async () => {
    const { element } = await mountBuilder(sampleDefinition());
    const assistants = async (): Promise<unknown> => ok(await element.executeAgentTool("describe_builder", {})).assistants;
    expect(await assistants()).toBe("unset");
    await saveRow(element, "allowed");
    expect((element.controller!.snapshot().configuration as Row).agentTools).toBe("allowed");
    expect(await assistants()).toBe("allowed");
    await saveRow(element, "off");
    expect(await assistants()).toBe("off");
    await saveRow(element, "");
    expect("agentTools" in (element.controller!.snapshot().configuration as Row)).toBe(false);
    expect(await assistants()).toBe("unset");
  }, 15_000);
});
