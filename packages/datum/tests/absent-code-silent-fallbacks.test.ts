import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Fallbacks that are never silent: each keeps its functional fallback and
 * also tells the host with `datum-error`, once per failure burst, and shows a visible state where
 * the fallback is a status. The chunks that fail are the files each loader imports (the mocks
 * below make that module's load throw), so the real loaders run.
 */
const { gone } = vi.hoisted(() => ({
  gone: { diagnoser: 0, diagnoserAsked: 0 }
}));

// The overview's diagnoser is reached through core/index (a static importer), so the module itself
// cannot fail to load in jsdom; reading its export is what the loader's `.then` does, and a getter
// that throws there is a rejected load.
vi.mock("../../../engine/form-engine/core/journey/journey-diagnostics.ts", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const module: Record<string, unknown> = { ...actual };
  Object.defineProperty(module, "diagnoseJourneys", {
    enumerable: true,
    get() {
      // The builder element's own problem count (src/journey-diagnostics.ts) reads the same export on its
      // own schedule; which of the two reads first depends on how long the overview's dynamic import
      // takes, so only the overview's read is the one that is counted and made to fail.
      if (!new Error().stack?.includes("overview-surface")) {
        return actual.diagnoseJourneys;
      }
      gone.diagnoserAsked += 1;
      if (gone.diagnoser > 0) {
        gone.diagnoser -= 1;
        throw new Error("diagnoser chunk gone");
      }
      return actual.diagnoseJourneys;
    }
  });
  return module;
});

// The real PDF support loads fonts over the network; only the imagery module's absence is under test.
vi.mock("../src/pdf.ts", () => ({ createPdfSupport: async () => ({ provider: {} }) }));

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { FormDefinition } from "@argusvane/datum-engine";

import { sampleDefinition, until } from "./helpers.js";

beforeEach(() => {
  gone.diagnoser = 0;
  gone.diagnoserAsked = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

function journeyDefinition(): FormDefinition {
  return { ...sampleDefinition(), journey: { journeys: [{ id: "apply", name: "Apply online", pages: [{ id: "p1", components: ["fullName"] }] }] } } as FormDefinition;
}

describe("the JSON editor's chunk is missing", () => {
  it("keeps the plain box and tells the host once per burst, from the box itself", async () => {
    // The builder's index imports the editor statically, so a fresh copy of the loader is made over a
    // mocked editor module whose first load throws (how a missing file looks to import()).
    const editorPath = "../../../engine/form-engine/builder/web-component/json-viewer.ts";
    const actual = await vi.importActual<Record<string, unknown>>(editorPath);
    let failing = 1;
    let asked = 0;
    vi.resetModules();
    vi.doMock(editorPath, () => {
      asked += 1;
      if (failing > 0) {
        failing -= 1;
        throw new Error("json viewer chunk gone");
      }
      return actual;
    });
    const { mountJsonViewerAfter } = await import("../../../engine/form-engine/builder/web-component/json-viewer-loader.js");
    const wrap = document.createElement("div");
    const first = document.createElement("pre");
    first.textContent = '{"a":1}';
    const second = document.createElement("textarea");
    second.value = '{"b":2}';
    wrap.append(first, second);
    document.body.append(wrap);
    const heard: Array<{ message: string; cause: unknown }> = [];
    const listen = (event: Event): void => {
      heard.push((event as CustomEvent<{ message: string; cause: unknown }>).detail);
    };
    document.addEventListener("datum-error", listen);
    const mounted = vi.fn();
    mountJsonViewerAfter(first, {} as never, mounted);
    mountJsonViewerAfter(second, {} as never, mounted);
    await settle();
    expect(mounted).not.toHaveBeenCalled();
    // The fallback is the JSON as it was: shown, not hidden, and the textarea still takes typing.
    expect(first.hidden).toBe(false);
    expect(second.hidden).toBe(false);
    expect(first.textContent).toBe('{"a":1}');
    expect(heard).toHaveLength(1);
    expect(heard[0]!.message).toContain("JSON editor");
    expect(heard[0]!.cause).toBeInstanceOf(Error);
    // The next open asks again (no cached rejection) and gets the editor.
    mountJsonViewerAfter(first, {} as never, mounted);
    await until(() => mounted.mock.calls.length === 1);
    expect(asked).toBe(2);
    expect(first.hidden).toBe(true);
    document.removeEventListener("datum-error", listen);
    vi.doUnmock(editorPath);
    vi.resetModules();
  });
});

describe("the Journeys overview's diagnoser is missing", () => {
  it("says Couldn't check, tells the host, and is not asked for again by a repaint", async () => {
    gone.diagnoser = 1;
    const element = document.createElement("datum-form-builder");
    element.setAttribute("pdf", "off");
    element.definition = journeyDefinition();
    const errors: Array<{ message: string; cause: unknown }> = [];
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string; cause: unknown }>).detail));
    document.body.append(element as DatumFormBuilderElement);
    await until(() => (element as DatumFormBuilderElement).journeyMode !== undefined);
    expect((element as DatumFormBuilderElement).setWorkspace("journeys")).toBe(true);
    const host = element.builder!.shadowRoot!.querySelector<HTMLElement>("[data-overview-host]")!;
    const status = (): string => host.querySelector("datum-builder-overview")?.shadowRoot?.querySelector(".status")?.textContent ?? "";
    await until(() => status().includes("Couldn't check"));
    expect(errors.some((entry) => entry.message.includes("could not be checked"))).toBe(true);
    // A repaint over the same definition does not ask again.
    const asked = gone.diagnoserAsked;
    (host.querySelector("datum-builder-overview") as unknown as { refresh(): void }).refresh();
    await settle();
    expect(gone.diagnoserAsked).toBe(asked);
    expect(status()).toContain("Couldn't check");
  });
});

describe("the PDF page imagery module is missing", () => {
  it("tells the host and hands the area editor a rasterizer that says why, instead of silently drawing blank sheets", async () => {
    const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    element.setAttribute("pdf", "auto");
    element.setAttribute("allow-origins", "https://nowhere.invalid");
    element.setAttribute("pdf-pages", "https://nowhere.invalid/datum-pdf-pages.js");
    const errors: Array<{ message: string; cause: unknown }> = [];
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string; cause: unknown }>).detail));
    // Not connected: the executor's loader is what is under test, not a whole builder session.
    const load = (element as unknown as { executorLoader(): () => Promise<{ pages?: { open(bytes: Uint8Array): Promise<unknown> } }> }).executorLoader();
    const support = await load();
    expect(errors.some((entry) => entry.message.includes("page images"))).toBe(true);
    // The support still has a rasterizer: opening a template says why there are no images (the editor's "Page images unavailable (reason)").
    expect(support.pages).toBeDefined();
    await expect(support.pages!.open(new Uint8Array())).rejects.toThrow(/nowhere\.invalid|could not be loaded/);
  });
});
