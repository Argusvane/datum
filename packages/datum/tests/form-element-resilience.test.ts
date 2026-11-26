import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/form.js";
import type { DatumFormElement } from "../src/form.js";

import { sampleDefinition, until } from "./helpers.js";
import { box, control } from "./live-dom.js";

const pdfLoads = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/pdf-loader.js", async (original) => {
  const real = await original<typeof import("../src/pdf-loader.js")>();
  return {
    ...real,
    loadPdfSupport: () => {
      pdfLoads.calls += 1;
      return Promise.reject(new Error("chunk 404"));
    }
  };
});

/**
 * <datum-form> and its renderer under hostile or awkward hosts: a property set to a clearing or
 * invalid value, a data source that answers nonsense or slowly, a definition cleared while an
 * answer is pending, a PDF chunk that fails once, a large prefill.
 */
const rejections: string[] = [];
const onRejection = (reason: unknown) => rejections.push(String((reason as Error)?.message ?? reason));

afterEach(() => {
  document.body.innerHTML = "";
  process.off("unhandledRejection", onRejection);
  rejections.length = 0;
  vi.restoreAllMocks();
});

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const silence = () => vi.spyOn(console, "error").mockImplementation(() => undefined);

function selectForm(sourceId: string): unknown {
  return {
    id: "res", version: "1", schemaVersion: "1",
    root: { id: "root", type: "form", configuration: {}, children: { content: [
      { id: "pick", type: "select", configuration: { label: "Pick", data: { sourceId } } },
      { id: "name", type: "text", configuration: { label: "Name" } }
    ] } }
  };
}

async function mount(definition: unknown, setup?: (el: DatumFormElement) => void, attributes: Record<string, string> = {}) {
  const element = document.createElement("datum-form") as DatumFormElement;
  const errors: string[] = [];
  element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent).detail.message));
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  setup?.(element);
  element.definition = definition as never;
  document.body.append(element);
  return { element, errors, shadow: () => element.renderer!.shadowRoot! };
}

describe("<datum-form> property setters", () => {
  it("dataSources = null clears the sources instead of throwing", async () => {
    silence();
    const { element } = await mount(sampleDefinition());
    expect(() => {
      (element as any).dataSources = null;
    }).not.toThrow();
    expect(element.dataSources).toBeUndefined();
  });

  it("an invalid mode is refused with a datum-error, keeps the mode, and rejects nothing", async () => {
    silence();
    process.on("unhandledRejection", onRejection);
    const { element, errors, shadow } = await mount(sampleDefinition());
    await until(() => shadow().querySelector("form"));
    (element as any).mode = null;
    (element as any).mode = "bogus";
    await tick(50);
    expect(errors.filter((message) => message.startsWith("mode must be")).length).toBe(2);
    expect(element.mode).toBe("interactive");
    expect(rejections).toEqual([]);
    expect(shadow().querySelector("form")).not.toBeNull();
  });
});

describe("<datum-form> prefill", () => {
  it("a values record is written with one recompute, every key set", async () => {
    silence();
    const { element, shadow } = await mount(sampleDefinition());
    await until(() => shadow().querySelector("form"));
    const runtime = element.runtime as any;
    const recompute = vi.spyOn(runtime.orchestrator, "recompute");
    const record: Record<string, number> = {};
    for (let i = 0; i < 200; i += 1) record[`k${i}`] = i;
    element.setAttribute("values", JSON.stringify(record));
    await until(() => Object.keys(element.values).length >= 200);
    expect(recompute.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe("<datum-form> data sources", () => {
  it.each<[string, () => unknown]>([
    ["items is a string", () => ({ items: "abc" })],
    ["items is null", () => ({ items: null })],
    ["items are numbers", () => [1, 2]],
    ["an item without a label", () => [{ value: "a" }]],
    ["an item value that is an object", () => [{ value: { a: 1 }, label: "o" }]],
    ["an item that is null", () => [null]]
  ])("a wrong-shaped answer (%s) is an empty answer with a datum-error, the form still paints", async (_name, loader) => {
    silence();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.on("unhandledRejection", onRejection);
    const { errors, shadow } = await mount(selectForm("src"), (el) => {
      el.dataSources = { src: loader } as never;
    });
    await until(() => shadow().querySelector("input"));
    await tick(50);
    expect(rejections).toEqual([]);
    expect(shadow().querySelector("form")).not.toBeNull();
    expect(errors.some((message) => message.includes("pick"))).toBe(true);
    expect(warn).toHaveBeenCalled();
    expect(Array.from(shadow().querySelectorAll("select option")).map((o) => o.textContent)).not.toContain("a");
  });

  it("clearing the definition while a source is pending never paints the old form when the answer lands", async () => {
    silence();
    let answer: (items: unknown[]) => void = () => undefined;
    const pending = new Promise<unknown[]>((resolve) => {
      answer = resolve;
    });
    const { element, shadow } = await mount(selectForm("slow"), (el) => {
      el.dataSources = { slow: () => pending } as never;
    });
    await tick();
    element.definition = undefined;
    await tick(50);
    answer([{ value: "a", label: "A list" }]);
    await tick(100);
    expect(shadow().querySelector("form")).toBeNull();
    expect(shadow().querySelectorAll("option").length).toBe(0);
  });

  it("an edit is drawn while a new request for the options is outstanding", async () => {
    silence();
    const countries = [{ value: "CA", label: "Canada" }];
    let slow = false;
    const waiting: Array<() => void> = [];
    const loader = () => {
      if (!slow) return Promise.resolve(countries);
      return new Promise<typeof countries>((resolve) => waiting.push(() => resolve(countries)));
    };
    const { element, shadow } = await mount(sampleDefinition(), (el) => {
      el.dataSources = { countries: loader } as never;
    });
    await until(() => box(shadow(), "country").querySelectorAll('option[value="CA"]').length === 1);
    slow = true;
    element.runtime!.setValue("fullName", "Ada Lovelace");
    element.runtime!.setValue("subscribe", true);
    await until(() => control(shadow(), "email"));
    // The options already known stay drawn meanwhile, and the real answer replaces them when it lands.
    expect(box(shadow(), "country").querySelectorAll('option[value="CA"]').length).toBe(1);
    expect(waiting.length).toBeGreaterThan(0);
    waiting.forEach((go) => go());
    await tick(50);
    expect(control(shadow(), "email")).not.toBeNull();
  });
});

describe("<datum-form> PDF support", () => {
  it("a PDF module that failed to load is asked for again by the next request", async () => {
    silence();
    pdfLoads.calls = 0;
    const element = document.createElement("datum-form") as DatumFormElement;
    element.setAttribute("pdf", "auto");
    element.definition = sampleDefinition() as never;
    document.body.append(element);
    await until(() => element.renderer?.shadowRoot?.querySelector("form"));
    await expect(element.downloadPdf()).rejects.toThrow(/chunk 404/);
    await element.downloadPdf().catch(() => undefined);
    expect(pdfLoads.calls).toBe(2);
  });
});
