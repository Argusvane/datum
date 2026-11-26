import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import { DEFAULT_FORM_IDENTITY } from "../src/support.js";
import { until } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const wrap = (children: unknown[], extra: Record<string, unknown> = {}): any => ({
  id: "guard",
  version: "1.0.0",
  schemaVersion: "1",
  ...extra,
  root: { id: "root", type: "form", configuration: {}, children: { content: children } }
});
const field = (id: string) => ({ id, type: "text", configuration: { label: id } });
const ids = (el: DatumFormBuilderElement) => el.controller?.snapshot().children?.content?.map((child) => child.id);

/** Every datum-error and every uncaught error the page hears while `run` goes. */
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
    await sleep(60);
  } finally {
    el.removeEventListener("datum-error", onDatumError);
    window.removeEventListener("error", onError);
  }
  return { heard, uncaught };
}

/** Makes the inner builder's `options` setter throw on its next `times` calls. */
function breakOptions(times: number): void {
  const inner = customElements.get("datum-builder")!;
  const descriptor = Object.getOwnPropertyDescriptor(inner.prototype, "options")!;
  let left = times;
  Object.defineProperty(inner.prototype, "options", {
    ...descriptor,
    configurable: true,
    set(this: unknown, value: unknown) {
      if (left > 0) {
        left -= 1;
        throw new Error("options boom");
      }
      descriptor.set!.call(this, value);
    }
  });
  restorers.push(() => Object.defineProperty(inner.prototype, "options", descriptor));
}
const restorers: Array<() => void> = [];
afterEach(() => {
  while (restorers.length > 0) {
    restorers.pop()!();
  }
});

describe("a flush that throws", () => {
  it("on first connect is told, not thrown into the page, and the form the builder could not take is not kept", async () => {
    const el = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    el.definition = wrap([field("a")]);
    breakOptions(1);
    const { heard, uncaught } = await listen(el, () => {
      document.body.append(el);
    });
    expect(uncaught).toEqual([]);
    expect(heard).toEqual(["The builder could not take the form: options boom"]);
    // The seed that threw is gone; the builder is seeded again with what it can hold: the form a
    // builder starts on, which is the one Submit button.
    await until(() => el.controller);
    expect(ids(el)).toEqual(["submit"]);
    expect(el.definition.id).toBe(DEFAULT_FORM_IDENTITY.id);
  });

  it("when queued puts the form before it back, and the sides after the options are still applied", async () => {
    const el = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    el.definition = wrap([field("keep")]);
    document.body.append(el);
    await until(() => el.controller);
    expect(ids(el)).toEqual(["keep"]);
    breakOptions(1);
    const { heard, uncaught } = await listen(el, () => {
      el.definition = wrap([field("other")], { marker: "other" });
    });
    expect(uncaught).toEqual([]);
    expect(heard).toEqual(["The builder could not take the form: options boom"]);
    expect(ids(el)).toEqual(["keep"]);
    expect((el.definition as unknown as { marker?: string }).marker).toBeUndefined();
    // The next form goes in.
    el.definition = wrap([field("next")]);
    await until(() => ids(el)?.[0] === "next");
  });

  it("for something other than the form's options says so in general words and keeps the form", async () => {
    const el = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    el.definition = wrap([field("keep")]);
    document.body.append(el);
    await until(() => el.controller);
    const inner = customElements.get("datum-builder")!;
    const descriptor = Object.getOwnPropertyDescriptor(inner.prototype, "layout")!;
    let thrown = false;
    Object.defineProperty(inner.prototype, "layout", {
      ...descriptor,
      configurable: true,
      set(this: unknown, value: unknown) {
        if (!thrown) {
          thrown = true;
          throw new Error("layout boom");
        }
        descriptor.set!.call(this, value);
      }
    });
    restorers.push(() => Object.defineProperty(inner.prototype, "layout", descriptor));
    const { heard, uncaught } = await listen(el, () => {
      el.layout = "wide" as never;
    });
    expect(uncaught).toEqual([]);
    expect(heard).toEqual(["The builder could not apply its settings: layout boom"]);
    expect(ids(el)).toEqual(["keep"]);
  });
});

describe("a form nested past what a host reads", () => {
  it("is told at the door as not loaded, and the form before it stays", async () => {
    const el = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    el.definition = wrap([field("keep")]);
    document.body.append(el);
    await until(() => el.controller);
    let nested: unknown = { leaf: true };
    for (let level = 0; level < 400; level += 1) {
      nested = { inner: nested };
    }
    const { heard, uncaught } = await listen(el, () => {
      el.definition = wrap([{ id: "deep", type: "text", configuration: { label: "Deep", extra: nested } }]);
    });
    expect(uncaught).toEqual([]);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatch(/^The form was not loaded: .*nests more than 320 levels/);
    expect(ids(el)).toEqual(["keep"]);
  });
});

describe("a definition handed over without an identity", () => {
  it("reads back with the default identity, the attribute and src routes' fill, and a full identity is untouched", async () => {
    const el = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    const root = wrap([field("a")]).root;
    el.definition = { root } as never;
    document.body.append(el);
    await until(() => el.controller);
    expect(el.definition.id).toBe(DEFAULT_FORM_IDENTITY.id);
    expect(el.definition.version).toBe(DEFAULT_FORM_IDENTITY.version);
    expect(el.definition.schemaVersion).toBe(DEFAULT_FORM_IDENTITY.schemaVersion);
    el.definition = { id: 5, version: 7, schemaVersion: null, root } as never;
    await until(() => el.definition.id === DEFAULT_FORM_IDENTITY.id);
    expect(el.definition.version).toBe(DEFAULT_FORM_IDENTITY.version);
    el.definition = wrap([field("a")]);
    await until(() => el.definition.id === "guard");
    expect(el.definition.version).toBe("1.0.0");
  });
});

describe("a language block from outside", () => {
  it("whose default language is not text loads, with no error, and the canvas has its tree", async () => {
    const el = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    el.definition = wrap([field("a")], { localization: { defaultLocale: 5, supportedLocales: [{ code: "en" }, { code: "fr", label: "Français" }] } });
    const { heard, uncaught } = await listen(el, async () => {
      document.body.append(el);
      await until(() => el.controller);
    });
    expect(uncaught).toEqual([]);
    expect(heard).toEqual([]);
    expect(ids(el)).toEqual(["a"]);
  });
});

describe("clearing a side with null", () => {
  it("drops the PDF layouts and the journeys without a word", async () => {
    const el = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    el.definition = wrap([field("a")]);
    document.body.append(el);
    await until(() => el.controller);
    const { heard } = await listen(el, () => {
      el.pdfConfiguration = null as never;
      el.journeyConfiguration = null as never;
    });
    expect(heard).toEqual([]);
    expect(el.definition.pdf).toBeUndefined();
    expect(el.definition.journey).toBeUndefined();
    expect("journey" in el.definition).toBe(false);
  });
});

describe("a header part that cannot key a translation", () => {
  it("loads, and the page is told once how it is put right", async () => {
    const el = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    const definition = wrap([field("a")]);
    definition.root.configuration = { chrome: { header: [{ type: "text", text: "No id" }] } };
    const { heard } = await listen(el, async () => {
      el.definition = definition;
      document.body.append(el);
      await until(() => el.controller);
    });
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatch(/^The form was loaded, but chrome header part 1 has no id: .*Header & footer panel/);
    expect(ids(el)).toEqual(["a"]);
  });
});
