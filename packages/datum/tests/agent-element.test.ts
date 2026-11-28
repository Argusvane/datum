import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The agent tools' element wiring: the opt-in `agent`
 * token loads the chunk once and the default and `all` never ask for it; `agentTools()` /
 * `executeAgentTool()` reject without the token and otherwise answer what the page registrar
 * answers; a fake ModelContext installed before mounting sees the tools and loses them
 * synchronously on disconnect; a `features` toggle that only adds or drops `agent` keeps the
 * runtime and its answers; two forms need the `form` argument and keep their handles; a form and
 * a builder share one session pair, with `target` required only then.
 */
const loads = vi.hoisted(() => ({ agent: 0, attachThrows: 0 }));
vi.mock("../src/agent-loader.js", async (original) => {
  const real = await original<typeof import("../src/agent-loader.js")>();
  // While `attachThrows` > 0 the chunk arrives but its attach throws (a host, registerForm or
  // catalogue failure), which the element must report and forget the way it does a failed load.
  const failing = <A extends unknown[], R>(attach: (...args: A) => R) =>
    (...args: A): R => {
      if (loads.attachThrows > 0) {
        loads.attachThrows -= 1;
        throw new Error("the agent attach broke");
      }
      return attach(...args);
    };
  return {
    ...real,
    loadAgent: () => {
      loads.agent += 1;
      return real.loadAgent().then((module) => ({
        ...module,
        attachFormAgent: failing(module.attachFormAgent)
      }));
    },
    // The builder's own chunk (the chunk split per bundle), counted with the form's.
    loadBuilderAgent: () => {
      loads.agent += 1;
      return real.loadBuilderAgent().then((module) => ({
        ...module,
        attachBuilderAgent: failing(module.attachBuilderAgent)
      }));
    }
  };
});

import "../src/form.js";
import "../src/builder.js";
import type { DatumFormElement } from "../src/form.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { DatumAgentToolsDetail } from "../src/agent.js";
import { BUILDER_AGENT_TOOL_NAMES, agentRegistrarFor, type AgentToolResult } from "@argusvane/datum-engine/agent";
import { createFakeModelContext } from "@argusvane/datum-engine/testing";
import type { FormDefinition } from "@argusvane/datum-engine";

import { sampleDefinition, until } from "./helpers.js";

type Row = Record<string, unknown>;

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(() => {
  unhandled.length = 0;
  loads.agent = 0;
  loads.attachThrows = 0;
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

/** The sample form without its data-source select, which reports a missing source on its own (it has none here). */
function plainDefinition(): FormDefinition {
  const sample = sampleDefinition();
  const content = (sample.root.children?.content ?? []).filter((node) => node.id !== "country");
  return { ...sample, root: { ...sample.root, children: { content } } };
}

interface Mounted {
  element: DatumFormElement;
  errors: Array<{ message: string; cause?: unknown }>;
  toolsEvents: DatumAgentToolsDetail[];
}

function mountForm(attributes: Record<string, string>, setup?: (element: DatumFormElement) => void): Mounted {
  const element = document.createElement("datum-form") as DatumFormElement;
  const errors: Mounted["errors"] = [];
  const toolsEvents: DatumAgentToolsDetail[] = [];
  element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent).detail));
  element.addEventListener("datum-agent-tools", (event) => toolsEvents.push((event as CustomEvent<DatumAgentToolsDetail>).detail));
  // Under the definition default a form with no agentTools is sealed; this helper keeps the live tools that the cases below expect.
  element.setAttribute("agent-access", "always");
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  setup?.(element);
  element.definition = plainDefinition();
  document.body.append(element);
  return { element, errors, toolsEvents };
}

async function mountBuilder(attributes: Record<string, string>): Promise<{ element: DatumFormBuilderElement; toolsEvents: DatumAgentToolsDetail[]; errors: Array<{ message: string; cause?: unknown }> }> {
  const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
  const toolsEvents: DatumAgentToolsDetail[] = [];
  const errors: Array<{ message: string; cause?: unknown }> = [];
  element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent).detail));
  element.addEventListener("datum-agent-tools", (event) => toolsEvents.push((event as CustomEvent<DatumAgentToolsDetail>).detail));
  // The PDF and Journeys sides left out, whatever else the list names.
  element.setAttribute("features", "-pdf -journeys");
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, name === "features" ? `${value} -pdf -journeys` : value);
  }
  element.definition = sampleDefinition();
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return { element, toolsEvents, errors };
}

const agentAbortOf = (element: HTMLElement): unknown => (element as unknown as { agentAbort?: unknown }).agentAbort;

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

describe("the agent token on <datum-form>", () => {
  it("features=\"all agent\" loads the chunk once per element; the absent default and all alone load nothing and create no controller", async () => {
    const plain = mountForm({});
    const all = mountForm({ features: "all" });
    await plain.element.ready;
    await all.element.ready;
    expect(loads.agent).toBe(0);
    expect(agentAbortOf(plain.element)).toBeUndefined();
    expect(agentAbortOf(all.element)).toBeUndefined();
    expect(plain.toolsEvents).toEqual([]);

    const on = mountForm({ features: "all agent" });
    await on.element.ready;
    expect(loads.agent).toBe(1);
    expect(agentAbortOf(on.element)).toBeInstanceOf(AbortController);
    // The same list again asks for nothing more.
    on.element.features = "all agent";
    await settle();
    expect(loads.agent).toBe(1);
    expect(on.errors).toEqual([]);
  });

  it("agentTools() and executeAgentTool() reject naming the agent token when the list leaves it out, and never load the chunk", async () => {
    const plain = mountForm({});
    const all = mountForm({ features: "all" });
    await plain.element.ready;
    await all.element.ready;
    await expect(plain.element.agentTools()).rejects.toThrow(/agentTools\(\) is not available: the features list of this <datum-form> does not include "agent"/);
    await expect(all.element.executeAgentTool("describe_form", {})).rejects.toThrow(/executeAgentTool\(\) is not available.*"agent"/);
    expect(loads.agent).toBe(0);
  });

  it("an attach that throws after the chunk arrived is reported once as datum-error and forgotten, so the next call attaches again", async () => {
    loads.attachThrows = 1;
    const { element, errors } = mountForm({ features: "all agent" });
    await element.ready;
    await until(() => errors.length > 0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("the agent attach broke");
    // Nothing is left half-attached: no controller, no attachment for the next call to wait on.
    expect(agentAbortOf(element)).toBeUndefined();
    const tools = await element.agentTools();
    expect(tools.map((tool) => tool.name)).toContain("describe_form");
    expect(loads.agent).toBe(2);
    expect(agentAbortOf(element)).toBeInstanceOf(AbortController);
    expect(errors).toHaveLength(1);
  });

  it("executeAgentTool answers the page registrar's envelope and agentTools() its wrappers; datum-agent-tools reports no-api without a browser API", async () => {
    const { element, toolsEvents } = mountForm({ features: "all agent" });
    await element.ready;
    const tools = await element.agentTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["begin_session", "check", "describe_form", "download_pdf", "drafts", "edit_rows", "end_session", "get_answers", "get_options", "navigate", "set_answers", "set_locale", "submit", "undo_agent_changes"]);
    const registrar = agentRegistrarFor(document);
    const through = ok(await element.executeAgentTool("describe_form", {}));
    const direct = ok(await registrar.execute("describe_form", {}));
    expect(through).toEqual(direct);
    // Mounted without an id: the registrar's own form-<n> handle, stamped on the envelope.
    expect(through.form).toMatch(/^form-\d+$/);
    // A refusal is an answer, never a rejection.
    const bad = refused(await element.executeAgentTool("set_answers", { answers: "nope" }));
    expect(bad.code).toBe("bad-input");
    await until(() => toolsEvents.length > 0);
    expect(toolsEvents[0]).toEqual({ registered: false, reason: "no-api", tools: [], target: "form", handle: through.form, access: "live" });
  });

  it("a fake ModelContext installed before mounting sees the tools, and loses them synchronously when the form leaves the page", async () => {
    const mc = createFakeModelContext();
    const restore = mc.install(document);
    try {
      const { element, toolsEvents } = mountForm({ features: "all agent" });
      await element.ready;
      await until(() => toolsEvents.some((detail) => detail.registered));
      const registered = toolsEvents.find((detail) => detail.registered)!;
      expect(registered.target).toBe("form");
      expect(registered.tools).toHaveLength(14);
      expect(mc.names()).toContain("describe_form");
      expect(mc.names()).toContain("begin_session");
      expect(mc.names()).toHaveLength(14);
      const entry = (await mc.getTools()).find((tool) => tool.name === "describe_form")!;
      const text = await mc.executeTool(entry, {});
      expect(JSON.parse(text as string)).toEqual(await element.executeAgentTool("describe_form", {}));

      element.remove();
      expect(mc.names()).toEqual([]);
      expect(toolsEvents.at(-1)).toEqual({ registered: false, tools: [], target: "form", handle: registered.handle, access: "off" });
      await expect(element.agentTools()).rejects.toThrow(/to be on the page/);
    } finally {
      restore();
    }
  });

  it("a features toggle all → all agent → all keeps the runtime and its answers, registering and withdrawing the tools alone", async () => {
    const { element, toolsEvents } = mountForm({ features: "all" });
    await element.ready;
    const runtime = element.runtime!;
    runtime.setValues({ fullName: "Ada" });
    expect(loads.agent).toBe(0);

    element.features = "all agent";
    await settle();
    expect(element.runtime).toBe(runtime);
    expect(runtime.formValues().fullName).toBe("Ada");
    expect(loads.agent).toBe(1);
    const answers = ok(await element.executeAgentTool("get_answers", {}));
    expect((answers.answers as Row[]).find((row) => row.path === "fullName")?.value).toBe("Ada");
    expect(element.features).toContain("agent");

    element.features = "all";
    await settle();
    expect(element.runtime).toBe(runtime);
    expect(runtime.formValues().fullName).toBe("Ada");
    expect(element.features).not.toContain("agent");
    expect(agentAbortOf(element)).toBeUndefined();
    await expect(element.agentTools()).rejects.toThrow(/"agent"/);
    expect(toolsEvents.at(-1)).toMatchObject({ registered: false, tools: [], target: "form" });

    // A list that changes more than the token rebuilds, as it always did.
    element.features = "minimal";
    await settle();
    await element.ready;
    expect(element.runtime).not.toBe(runtime);
  });

  it("two forms: every tool but describe_form needs the form handle, describe_form lists both with formId, and a handle survives the other form leaving", async () => {
    const first = mountForm({ features: "all agent", id: "agent-two-a" });
    const second = mountForm({ features: "all agent", id: "agent-two-b" });
    await first.element.ready;
    await second.element.ready;
    const required = refused(await first.element.executeAgentTool("get_answers", {}));
    expect(required.code).toBe("form-required");
    expect(((required.details as Row).forms as Row[]).map((summary) => summary.form)).toEqual(expect.arrayContaining(["agent-two-a", "agent-two-b"]));
    const listing = ok(await second.element.executeAgentTool("describe_form", {}));
    expect("revision" in listing).toBe(false);
    expect(listing.forms).toEqual([
      expect.objectContaining({ form: "agent-two-a", formId: "sample-form", session: false }),
      expect.objectContaining({ form: "agent-two-b", formId: "sample-form", session: false })
    ]);
    const addressed = ok(await first.element.executeAgentTool("describe_form", { form: "agent-two-b" }));
    expect(addressed.form).toBe("agent-two-b");

    first.element.remove();
    const alone = ok(await second.element.executeAgentTool("describe_form", {}));
    expect(alone.form).toBe("agent-two-b");
    expect(alone.formId).toBe("sample-form");
  });

  it("anonymous form-<n> handles are neither renumbered nor reused when one form leaves", async () => {
    const first = mountForm({ features: "all agent" });
    const second = mountForm({ features: "all agent" });
    await first.element.ready;
    await second.element.ready;
    const listing = ok(await second.element.executeAgentTool("describe_form", {}));
    const handles = (listing.forms as Row[]).map((summary) => summary.form as string);
    expect(handles).toHaveLength(2);
    for (const handle of handles) {
      expect(handle).toMatch(/^form-\d+$/);
    }
    await until(() => second.toolsEvents.length > 0);
    const secondHandle = second.toolsEvents[0]!.handle;
    const firstHandle = handles.find((handle) => handle !== secondHandle)!;
    expect(handles).toContain(secondHandle);

    first.element.remove();
    const alone = ok(await second.element.executeAgentTool("describe_form", {}));
    expect(alone.form).toBe(secondHandle);

    const third = mountForm({ features: "all agent" });
    await third.element.ready;
    await until(() => third.toolsEvents.length > 0);
    const thirdHandle = third.toolsEvents[0]!.handle;
    expect(thirdHandle).toMatch(/^form-\d+$/);
    expect(thirdHandle).not.toBe(firstHandle);
    expect(thirdHandle).not.toBe(secondHandle);
  });

  it("datum-agent-tools follows the page: again on a features change that keeps the token, and when a builder joins", async () => {
    const mc = createFakeModelContext();
    const restore = mc.install(document);
    try {
      const { element, toolsEvents } = mountForm({ features: "all agent" });
      await element.ready;
      await until(() => toolsEvents.some((detail) => detail.registered));
      const before = toolsEvents.length;
      expect(toolsEvents.at(-1)!.tools).toHaveLength(14);

      // A list that changes more than the token, keeping it, says the tools again.
      element.features = "minimal agent";
      await settle();
      await element.ready;
      expect(toolsEvents.length).toBeGreaterThan(before);
      expect(toolsEvents.at(-1)).toMatchObject({ registered: true, target: "form" });

      // Another target changing the page's tools is heard too: with a builder registered, the
      // form leaving drops the renderer's tools, and the builder's listeners are told.
      const { element: builder, toolsEvents: builderEvents } = await mountBuilder({ features: "all agent", id: "agent-follow-builder" });
      await builder.agentTools();
      await until(() => builderEvents.some((detail) => detail.registered));
      expect(builderEvents.at(-1)!.tools).toContain("describe_form");
      const counted = builderEvents.length;
      element.remove();
      await until(() => builderEvents.length > counted);
      expect(builderEvents.at(-1)).toMatchObject({ target: "builder", handle: "agent-follow-builder" });
      expect(builderEvents.at(-1)!.tools).not.toContain("describe_form");
      expect([...builderEvents.at(-1)!.tools].sort()).toEqual([...mc.names()].sort());
    } finally {
      restore();
    }
  });
});

describe("the agent token on <datum-form-builder>", () => {
  it("registers under its id (else builder-<n>), exposes its twenty-four tools and the session pair, and needs no target on a page without a form", async () => {
    const { element, toolsEvents } = await mountBuilder({ features: "all agent", id: "agent-builder-solo" });
    const tools = await element.agentTools();
    const names = tools.map((tool) => tool.name);
    expect(names.filter((name) => name === "begin_session")).toHaveLength(1);
    expect(names.filter((name) => name === "end_session")).toHaveLength(1);
    // The builder's own catalogue, in BUILDER_AGENT_TOOL_NAMES order, beside the pair.
    expect(names.filter((name) => name !== "begin_session" && name !== "end_session")).toEqual([...BUILDER_AGENT_TOOL_NAMES]);
    expect(BUILDER_AGENT_TOOL_NAMES).toHaveLength(24);
    await until(() => toolsEvents.length > 0);
    expect(toolsEvents[0]).toMatchObject({ target: "builder", handle: "agent-builder-solo", registered: false, reason: "no-api" });
    // The element's host locks the shell (inert + banner), so the session reports locked: true.
    const begun = ok(await element.executeAgentTool("begin_session", { purpose: "Tidy the form" }));
    expect(begun).toMatchObject({ builder: "agent-builder-solo", locked: true });
    expect(element.builder!.hasAttribute("inert")).toBe(true);
    expect(ok(await element.executeAgentTool("end_session", { summary: "Done." })).wasOpen).toBe(true);
    expect(element.builder!.hasAttribute("inert")).toBe(false);

    const anonymous = await mountBuilder({ features: "all agent" });
    await until(() => anonymous.toolsEvents.length > 0);
    expect(anonymous.toolsEvents[0]!.handle).toMatch(/^builder-\d+$/);
    expect(agentAbortOf(anonymous.element)).toBeInstanceOf(AbortController);
  });

  it("an attach that throws is reported once as datum-error and forgotten, so the next call attaches again", async () => {
    loads.attachThrows = 1;
    const { element, errors } = await mountBuilder({ features: "all agent", id: "agent-builder-attach" });
    await until(() => errors.length > 0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("the agent attach broke");
    expect(agentAbortOf(element)).toBeUndefined();
    const names = (await element.agentTools()).map((tool) => tool.name);
    expect(names).toContain("begin_session");
    expect(loads.agent).toBe(2);
    expect(errors).toHaveLength(1);
  });

  it("a features toggle all → all agent → all keeps the builder and its controller, registering and withdrawing the tools alone", async () => {
    const { element, toolsEvents } = await mountBuilder({ features: "all", id: "agent-builder-toggle" });
    const builder = element.builder;
    const controller = element.controller;
    expect(builder).toBeDefined();
    expect(controller).toBeDefined();
    expect(loads.agent).toBe(0);

    element.features = "all agent -pdf -journeys";
    await until(() => toolsEvents.length > 0);
    expect(element.builder).toBe(builder);
    expect(element.controller).toBe(controller);
    expect(loads.agent).toBe(1);
    expect(toolsEvents.at(-1)).toMatchObject({ target: "builder", handle: "agent-builder-toggle", reason: "no-api" });
    const names = (await element.agentTools()).map((tool) => tool.name);
    expect(names).toContain("begin_session");

    const before = toolsEvents.length;
    element.features = "all -pdf -journeys";
    await settle();
    expect(element.builder).toBe(builder);
    expect(element.controller).toBe(controller);
    expect(agentAbortOf(element)).toBeUndefined();
    expect(toolsEvents.length).toBeGreaterThan(before);
    expect(toolsEvents.at(-1)).toEqual({ registered: false, tools: [], target: "builder", handle: "agent-builder-toggle", access: "off" });
    await expect(element.agentTools()).rejects.toThrow(/"agent"/);
    expect(loads.agent).toBe(1);
  });

  it("rejects agentTools() without the token and loads nothing", async () => {
    const { element } = await mountBuilder({ features: "all" });
    await expect(element.agentTools()).rejects.toThrow(/agentTools\(\) is not available: the features list of this <datum-form-builder> does not include "agent"/);
    expect(loads.agent).toBe(0);
    expect(agentAbortOf(element)).toBeUndefined();
  });

  it("a form and a builder share one session pair: begin_session needs target, and target: builder locks the builder alone", async () => {
    const form = mountForm({ features: "all agent", id: "agent-pair-form" });
    await form.element.ready;
    const { element: builder } = await mountBuilder({ features: "all agent", id: "agent-pair-builder" });
    const names = (await builder.agentTools()).map((tool) => tool.name);
    expect(names.filter((name) => name === "begin_session")).toHaveLength(1);
    expect(names.filter((name) => name === "end_session")).toHaveLength(1);
    expect(names).toContain("describe_form");
    expect(names).toContain("describe_builder");
    // Fourteen renderer names (twelve tools and the pair) and the builder's twenty-four, each once.
    expect(names).toHaveLength(38);
    expect(new Set(names).size).toBe(38);
    const missing = refused(await builder.executeAgentTool("begin_session", { purpose: "x" }));
    expect(missing.code).toBe("target-required");
    const begun = ok(await form.element.executeAgentTool("begin_session", { purpose: "x", target: "builder" }));
    expect(begun).toMatchObject({ builder: "agent-pair-builder", locked: true });
    expect(builder.builder!.hasAttribute("inert")).toBe(true);
    expect(form.element.renderer?.hasAttribute("inert")).toBe(false);
    ok(await builder.executeAgentTool("end_session", { summary: "Done.", target: "builder" }));
    expect(builder.builder!.hasAttribute("inert")).toBe(false);
    const onForm = ok(await form.element.executeAgentTool("begin_session", { purpose: "y", target: "form" }));
    expect(onForm).toMatchObject({ form: "agent-pair-form", locked: true });
    expect(form.element.renderer?.hasAttribute("inert")).toBe(true);
    ok(await form.element.executeAgentTool("end_session", { summary: "Done.", target: "form" }));
    expect(form.element.renderer?.hasAttribute("inert")).toBe(false);
  });
});
