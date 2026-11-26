import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import { until } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/*
 * A form whose values nest past what a host reads (320 levels) is not taken on any route a
 * definition arrives by: Open, the `definition` property and attribute, `src`, and the
 * `journey` / `pdf` sides. Each reports "The form was not loaded: ..." as a datum-error, and the
 * form the author had stays.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const wrap = (children: unknown[]): any => ({
  id: "guard",
  version: "1.0.0",
  schemaVersion: "1",
  root: { id: "root", type: "form", configuration: {}, children: { content: children } }
});
const field = (id: string, extra?: unknown) => ({ id, type: "text", configuration: { label: id, ...(extra === undefined ? {} : { extra }) } });
const ids = (el: DatumFormBuilderElement) => el.controller?.snapshot().children?.content?.map((child) => child.id);

function nested(levels: number): unknown {
  let value: unknown = { leaf: true };
  for (let level = 0; level < levels; level += 1) {
    value = { inner: value };
  }
  return value;
}
const deepForm = () => wrap([field("deep", nested(400))]);

async function listen(el: HTMLElement, run: () => Promise<void> | void): Promise<{ heard: string[]; uncaught: string[] }> {
  const heard: string[] = [];
  const uncaught: string[] = [];
  const onDatumError = (event: Event) => heard.push((event as CustomEvent<{ message: string }>).detail.message);
  const onError = (event: ErrorEvent) => {
    uncaught.push(event.message);
    event.preventDefault();
  };
  el.addEventListener("datum-error", onDatumError);
  window.addEventListener("error", onError);
  try {
    await run();
    await sleep(80);
  } finally {
    el.removeEventListener("datum-error", onDatumError);
    window.removeEventListener("error", onError);
  }
  return { heard, uncaught };
}

async function mounted(): Promise<DatumFormBuilderElement> {
  const el = document.createElement("datum-form-builder") as DatumFormBuilderElement;
  el.definition = wrap([field("keep")]);
  document.body.append(el);
  await until(() => el.controller);
  return el;
}

const NOT_LOADED = /^The form was not loaded: .*nests more than 320 levels/;

describe("a form nested past 320 levels", () => {
  it("is not loaded by the definition property, and the form before it stays", async () => {
    const el = await mounted();
    const { heard, uncaught } = await listen(el, () => {
      el.definition = deepForm();
    });
    expect(uncaught).toEqual([]);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatch(NOT_LOADED);
    expect(ids(el)).toEqual(["keep"]);
    expect(el.definition.root.children?.content?.[0]?.id).toBe("keep");
  });

  it("is not loaded by the definition attribute", async () => {
    const el = await mounted();
    const { heard, uncaught } = await listen(el, () => {
      el.setAttribute("definition", JSON.stringify(deepForm()));
    });
    expect(uncaught).toEqual([]);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatch(NOT_LOADED);
    expect(ids(el)).toEqual(["keep"]);
  });

  it("is not loaded from src", async () => {
    // The form the author has came from src too: an assigned one would refuse src outright.
    let served: unknown = wrap([field("keep")]);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(served), { status: 200, headers: { "content-type": "application/json" } }));
    const el = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    el.src = "https://forms.example/keep.json";
    document.body.append(el);
    await until(() => ids(el)?.[0] === "keep");
    served = deepForm();
    const { heard, uncaught } = await listen(el, () => {
      el.src = "https://forms.example/deep.json";
    });
    expect(uncaught).toEqual([]);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatch(NOT_LOADED);
    expect(ids(el)).toEqual(["keep"]);
  });

  it("is not opened from a file, and the form before it stays", async () => {
    const el = await mounted();
    let thrown = "";
    const { uncaught } = await listen(el, () => {
      try {
        const apply = el.fileActions.open!({ name: "deep.json", text: JSON.stringify(deepForm()) }) as unknown as () => void;
        apply();
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error);
      }
    });
    expect(uncaught).toEqual([]);
    expect(thrown).toMatch(/nests more than 320 levels/);
    expect(ids(el)).toEqual(["keep"]);
  });

  it("is not taken by the journey side or the pdf side", async () => {
    const el = await mounted();
    const { heard, uncaught } = await listen(el, () => {
      el.journeyConfiguration = { journeys: [], "x-note": nested(400) } as never;
      el.pdfConfiguration = { layouts: [], "x-note": nested(400) } as never;
    });
    expect(uncaught).toEqual([]);
    expect(ids(el)).toEqual(["keep"]);
    expect(heard).toHaveLength(2);
    expect(heard[0]).toMatch(/nests more than 320 levels/);
    expect(heard[1]).toMatch(/nests more than 320 levels/);
    expect(JSON.stringify(el.journeyConfiguration ?? null)).not.toContain("x-note");
    expect(JSON.stringify(el.pdfConfiguration ?? null)).not.toContain("x-note");
  });
});
