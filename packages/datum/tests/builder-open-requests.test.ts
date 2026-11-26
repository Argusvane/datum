import { afterEach, describe, expect, it, vi } from "vitest";
import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { FormDefinition } from "@argusvane/datum-engine";
import { until } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function hostile(): FormDefinition {
  return {
    id: "shared",
    version: "1.0.0",
    schemaVersion: "1",
    dataSources: [{ id: "c", providerId: "https://attacker.example/provider", version: "1", defaultQuery: { u: "https://attacker.example/q" } }],
    root: {
      id: "root",
      type: "form",
      configuration: {
        title: "T",
        chrome: { header: [{ type: "image", src: "https://attacker.example/chrome.png?t=1" }] }
      },
      children: {
        content: [
          { id: "img", type: "image", configuration: { src: "https://attacker.example/pixel.png?who=opener", alt: "" } },
          { id: "same", type: "image", configuration: { src: "/user/logout?token=1" } },
          { id: "js", type: "image", configuration: { src: "javascript:alert(1)" } },
          { id: "h", type: "html", configuration: { html: '<img src="//attacker.example/h.png"><a href="https://attacker.example/" target="_blank">x</a>' } }
        ]
      }
    }
  } as unknown as FormDefinition;
}

// Opening a shared definition must not make the opener's browser request
// attacker-chosen remote images; they wait for one "Load remote content?" confirmation per document.
describe("builder open requests", () => {
  it("holds cross-origin images until confirmed, sets no-referrer/anonymous on the rest", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", (u: unknown) => {
      fetched.push(String(u));
      return Promise.reject(new Error("blocked"));
    });
    const el = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    document.body.append(el);
    await until(() => el.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    const apply = el.fileActions.open!({ name: "x.json", text: JSON.stringify(hostile()) }) as unknown as () => void;
    apply();
    await new Promise((r) => setTimeout(r, 300));
    const imgs: HTMLImageElement[] = [];
    const walk = (root: ParentNode): void => {
      root.querySelectorAll("img").forEach((i) => imgs.push(i));
      root.querySelectorAll("*").forEach((n) => {
        if ((n as HTMLElement).shadowRoot) walk((n as HTMLElement).shadowRoot!);
      });
    };
    walk(el.shadowRoot ?? el);
    walk(el);
    const live = (i: HTMLImageElement): string => i.getAttribute("src") ?? "";
    expect(imgs.some((i) => /attacker\.example/.test(live(i)))).toBe(false);
    const held = imgs.filter((i) => /attacker\.example/.test(i.dataset.remoteSrc ?? ""));
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((i) => i.getAttribute("referrerpolicy") === "no-referrer" && i.getAttribute("crossorigin") === "anonymous")).toBe(true);
    expect(imgs.some((i) => live(i).startsWith("javascript:"))).toBe(false);
    expect(fetched).toEqual([]);

    // Confirming once loads them.
    vi.stubGlobal("confirm", () => true);
    const canvas = el.builder!.shadowRoot!.querySelector("datum-builder-canvas") as HTMLElement;
    const renderer = canvas.shadowRoot!.querySelector("datum-form-renderer") as HTMLElement;
    (renderer.shadowRoot!.querySelector("[data-remote-load]") as HTMLElement).click();
    expect(imgs.some((i) => /attacker\.example/.test(live(i)))).toBe(true);
    expect(renderer.shadowRoot!.querySelector("[data-remote-load]")).toBeNull();
  });
});

// The confirmation is per load (a file reusing the id is asked again),
// and a rebuilt renderer is guarded too.
describe("builder remote image confirmation", () => {
  it("asks again when another file with the same id is opened", async () => {
    vi.stubGlobal("confirm", () => true);
    const doc = (url: string): string =>
      JSON.stringify({ id: "contact", version: "1.0.0", schemaVersion: "1", root: { id: "root", type: "form", configuration: { title: "T" }, children: { content: [{ id: "img", type: "image", configuration: { src: url, alt: "" } }] } } });
    const el = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    document.body.append(el);
    await until(() => el.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    const open = (text: string): void => (el.fileActions.open!({ name: "x.json", text }) as unknown as () => void)();
    const rendererRoot = (): ShadowRoot => {
      const canvas = el.builder!.shadowRoot!.querySelector("datum-builder-canvas") as HTMLElement;
      return (canvas.shadowRoot!.querySelector("datum-form-renderer") as HTMLElement).shadowRoot!;
    };
    open(doc("https://a.example/1.png"));
    await new Promise((r) => setTimeout(r, 300));
    (rendererRoot().querySelector("[data-remote-load]") as HTMLElement).click();
    expect(rendererRoot().querySelector("img[data-remote-src]")).toBeNull();
    open(doc("https://evil.example/2.png"));
    await new Promise((r) => setTimeout(r, 300));
    const image = rendererRoot().querySelector("img")!;
    expect(image.hasAttribute("src")).toBe(false);
    expect(image.dataset.remoteSrc).toBe("https://evil.example/2.png");
  });

  it("guards a renderer rebuilt after the canvas lost its controller", async () => {
    const el = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    document.body.append(el);
    await until(() => el.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    const canvas = el.builder!.shadowRoot!.querySelector("datum-builder-canvas") as any;
    const controller = canvas.ctrl;
    canvas.controller = undefined;
    canvas.controller = controller;
    const root = (canvas.shadowRoot!.querySelector("datum-form-renderer") as HTMLElement).shadowRoot!;
    const image = document.createElement("img");
    image.setAttribute("src", "https://evil.example/r.png");
    root.append(image);
    await new Promise((r) => setTimeout(r, 50));
    expect(image.hasAttribute("src")).toBe(false);
    expect(image.dataset.remoteSrc).toBe("https://evil.example/r.png");
  });
});
