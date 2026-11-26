import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Absent-code resilience for the agent tools: a host may deploy a bundle
 * without its agent chunk (datum-form-agent-*.js, datum-builder-agent-*.js). With
 * `features="all agent"` a chunk that is not there reaches the page once as `datum-error` with a
 * ChunkLoadError whose cause chain holds the import error; `agentTools()` rejects with that error;
 * the element keeps working (the form renders, takes typing and submits; the builder takes an
 * edit); no rejection goes unhandled; and the next call asks for the chunk again (no cached
 * rejection), succeeding once the chunk is back. The REAL loaders run (agent-loader.ts): what
 * fails is the module each imports (the mocks make its factory throw, which is how a missing
 * file looks to `import()`).
 */
const chunk = vi.hoisted(() => ({ fail: 0, asked: 0, builderFail: 0, builderAsked: 0 }));
vi.mock("../src/agent.ts", async (importActual) => {
  chunk.asked += 1;
  if (chunk.fail > 0) {
    chunk.fail -= 1;
    throw new Error("agent chunk gone");
  }
  return importActual();
});
vi.mock("../src/builder/agent.ts", async (importActual) => {
  chunk.builderAsked += 1;
  if (chunk.builderFail > 0) {
    chunk.builderFail -= 1;
    throw new Error("builder agent chunk gone");
  }
  return importActual();
});

import "../src/form.js";
import "../src/builder.js";
import type { DatumErrorDetail, DatumFormElement } from "../src/form.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import { ChunkLoadError } from "../src/chunk-load-error.js";

import { sampleDefinition, typeInto, until } from "./helpers.js";

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

/** The messages down an error's cause chain (vitest words a throwing mock factory its own way, with the original as its cause). */
function causeChain(error: unknown): string {
  const texts: string[] = [];
  for (let at: unknown = error; at instanceof Error && texts.length < 6; at = (at as { cause?: unknown }).cause) {
    texts.push(at.message);
  }
  return texts.join(" | ");
}

describe("the agent chunk missing from <datum-form>", () => {
  it("reports one datum-error with a ChunkLoadError, rejects agentTools(), keeps the form working and asks again", async () => {
    chunk.fail = 1;
    const asked = chunk.asked;
    const element = document.createElement("datum-form") as DatumFormElement;
    element.setAttribute("features", "all agent");
    element.definition = sampleDefinition();
    // Only the agent chunk's reports: the sample's data-source select reports its own missing source.
    const errors: DatumErrorDetail[] = [];
    element.addEventListener("datum-error", (event) => {
      const detail = (event as CustomEvent<DatumErrorDetail>).detail;
      if (detail.cause instanceof ChunkLoadError) {
        errors.push(detail);
      }
    });
    document.body.append(element);
    await until(() => element.renderer?.shadowRoot?.querySelector("[data-component-id='fullName'] input"));
    await until(() => errors.length > 0);
    await settle();

    // Once, for the one load the connection asked for.
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("file.unavailable");
    expect(errors[0]!.message).toContain("The agent tools (datum-form-agent-*.js / datum-builder-agent-*.js) could not be loaded");
    expect(errors[0]!.cause).toBeInstanceOf(ChunkLoadError);
    expect(causeChain(errors[0]!.cause)).toContain("agent chunk gone");
    expect(chunk.asked - asked).toBe(1);
    expect(element.agentAccess).toBeUndefined(); // the definition default: still wanted, sealed, so the chunk is still asked for

    // The form renders, takes typing and submits without the agent tools.
    const input = element.renderer!.shadowRoot!.querySelector<HTMLInputElement>("[data-component-id='fullName'] input")!;
    typeInto(input, "Ada Lovelace");
    await until(() => (element.values as Record<string, unknown>).fullName === "Ada Lovelace");
    const outcome = await element.submit();
    expect(outcome.submission).toBeDefined();

    // Still gone: the next call asks again and rejects with the loader's error (and reports it).
    chunk.fail = 1;
    const error = await element.agentTools().then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect(error).toBeInstanceOf(ChunkLoadError);
    expect(causeChain(error)).toContain("agent chunk gone");
    expect(chunk.asked - asked).toBeGreaterThanOrEqual(2);

    // Back: the next call loads the chunk and answers the tools.
    const tools = await element.agentTools();
    expect(tools.map((tool) => tool.name)).toContain("describe_form");
    expect(chunk.asked - asked).toBeGreaterThanOrEqual(3);

    await settle();
    expect(unhandled).toEqual([]);
  });
});

describe("the agent chunk missing from <datum-form-builder>", () => {
  it("reports datum-error with a ChunkLoadError, rejects agentTools(), keeps the builder editing and asks again", async () => {
    chunk.builderFail = 1;
    const asked = chunk.builderAsked;
    const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    element.setAttribute("pdf", "off");
    element.setAttribute("journeys", "off");
    element.setAttribute("features", "all agent");
    element.definition = sampleDefinition();
    // Only the agent chunk's reports: the sample's data-source select reports its own missing source.
    const errors: DatumErrorDetail[] = [];
    element.addEventListener("datum-error", (event) => {
      const detail = (event as CustomEvent<DatumErrorDetail>).detail;
      if (detail.cause instanceof ChunkLoadError) {
        errors.push(detail);
      }
    });
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    await until(() => errors.length > 0);
    await settle();

    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("file.unavailable");
    expect(errors[0]!.cause).toBeInstanceOf(ChunkLoadError);
    expect(causeChain(errors[0]!.cause)).toContain("builder agent chunk gone");
    expect(chunk.builderAsked - asked).toBe(1);

    // The builder still takes an edit.
    const id = element.controller!.addAfter("text", "fullName");
    expect(id).toBeTruthy();
    expect(JSON.stringify(element.definition)).toContain(`"${id}"`);

    const tools = await element.agentTools();
    expect(tools.map((tool) => tool.name)).toContain("begin_session");
    expect(chunk.builderAsked - asked).toBeGreaterThanOrEqual(2);

    await settle();
    expect(unhandled).toEqual([]);
  });
});
