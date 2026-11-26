import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * Taking the builder off the page and putting it back (a framework moving it, a host re-parenting
 * it) replaces its shadow DOM. The lazy workspace surfaces and the palette that lived in the old
 * markup must be loaded afresh into the new one, and a load that was still in flight for the old
 * markup must land nowhere.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;

async function mount(): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = sampleDefinition();
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  // The three modes register in one tick: wait for the last, never for a count.
  await until(() => element.pdfMode !== undefined && element.journeyMode !== undefined);
  return element;
}

/** Off the page and back on, as a host would move it. */
function reconnect(element: DatumFormBuilderElement): void {
  element.remove();
  document.body.append(element);
}

/** The inner builder's private fields, which the reconnect guard is observable through. */
type Inner = {
  domGeneration: number;
  logicLoading: boolean;
  logicEl: HTMLElement | undefined;
  setWorkspace(workspace: string): void;
};
const innerOf = (element: DatumFormBuilderElement): Inner => element.builder as unknown as Inner;
const settle = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const hostOf = (element: DatumFormBuilderElement, attribute: string): HTMLElement => shell(element).querySelector<HTMLElement>(`[${attribute}]`)!;

describe("the builder after it is removed and re-appended", () => {
  it("loads the Logic surface into the new host, and the old one is gone", async () => {
    const element = await mount();
    element.builder!.setWorkspace("logic");
    await until(() => hostOf(element, "data-logic-host").querySelector("datum-builder-logic"));
    const before = hostOf(element, "data-logic-host").querySelector("datum-builder-logic")!;

    reconnect(element);
    await until(() => hostOf(element, "data-logic-host").querySelector("datum-builder-logic"));

    const after = hostOf(element, "data-logic-host").querySelector("datum-builder-logic")!;
    expect(after).not.toBe(before);
    expect(after.isConnected).toBe(true);
    expect(before.isConnected).toBe(false);
    expect(shell(element).querySelectorAll("datum-builder-logic")).toHaveLength(1);
  });

  it("attaches exactly one Logic surface when the removal comes before the chunk answers", async () => {
    const element = await mount();
    element.builder!.setWorkspace("logic");
    // The chunk's answer is a later microtask at the earliest: the reconnect lands first.
    reconnect(element);
    await until(() => hostOf(element, "data-logic-host").querySelector("datum-builder-logic"));
    // Let any answer left over for the old markup arrive.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(shell(element).querySelectorAll("datum-builder-logic")).toHaveLength(1);
    const surface = hostOf(element, "data-logic-host").querySelector("datum-builder-logic")!;
    expect(surface.isConnected).toBe(true);
  });

  it("loads the Data surface into the new host", async () => {
    const element = await mount();
    element.builder!.setWorkspace("data");
    await until(() => hostOf(element, "data-data-host").querySelector("datum-builder-data"));
    const before = hostOf(element, "data-data-host").querySelector("datum-builder-data")!;

    reconnect(element);
    await until(() => hostOf(element, "data-data-host").querySelector("datum-builder-data"));

    const after = hostOf(element, "data-data-host").querySelector("datum-builder-data")!;
    expect(after).not.toBe(before);
    expect(after.isConnected).toBe(true);
  });

  it("opens the palette in the live root after a reconnect", async () => {
    const element = await mount();
    await element.builder!.openPalette();
    await until(() => shell(element).querySelector("datum-builder-palette"));
    const before = shell(element).querySelector("datum-builder-palette")!;
    expect((before as HTMLElement & { isOpen: boolean }).isOpen).toBe(true);

    reconnect(element);
    // The old palette went with the old markup; opening again builds one in the new root.
    expect(shell(element).querySelector("datum-builder-palette")).toBeNull();
    await element.builder!.openPalette();
    await until(() => shell(element).querySelector("datum-builder-palette"));

    const after = shell(element).querySelector("datum-builder-palette") as HTMLElement & { isOpen: boolean };
    expect(after).not.toBe(before);
    expect(after.isConnected).toBe(true);
    expect(after.isOpen).toBe(true);
  });

  it("ignores a Logic load still in flight for the old markup after the workspace was left", async () => {
    const element = await mount();
    const inner = innerOf(element);
    inner.setWorkspace("logic");
    const generation = inner.domGeneration;
    // Leave Logic before the chunk answers, then move the builder: the answer is now stale.
    inner.setWorkspace("form");
    reconnect(element);
    expect(inner.domGeneration).toBe(generation + 1);
    expect(inner.logicLoading).toBe(false);

    await settle(200);
    // Without the guard the stale answer would have set logicEl to a surface in the old root.
    expect(inner.logicEl).toBeUndefined();

    inner.setWorkspace("logic");
    await until(() => hostOf(element, "data-logic-host").querySelector("datum-builder-logic"));
    expect(inner.logicEl!.isConnected).toBe(true);
    expect(shell(element).querySelectorAll("datum-builder-logic")).toHaveLength(1);
  });

  it.each([
    ["data", "data-data-host", "datum-builder-data"],
    ["languages", "data-languages-host", "datum-builder-languages"],
    ["journeys", "data-overview-host", "datum-builder-overview"]
  ])("attaches one %s surface when the reconnect lands mid-load, and after leaving and coming back", async (workspace, attribute, tag) => {
    const element = await mount();
    const inner = innerOf(element);

    inner.setWorkspace(workspace);
    reconnect(element);
    await until(() => hostOf(element, attribute).querySelector(tag));
    await settle();
    expect(shell(element).querySelectorAll(tag)).toHaveLength(1);
    expect(hostOf(element, attribute).querySelector(tag)!.isConnected).toBe(true);

    // Leave, move, return: the surface is loaded afresh, and still only one is on the page.
    inner.setWorkspace("form");
    reconnect(element);
    inner.setWorkspace(workspace);
    await until(() => hostOf(element, attribute).querySelector(tag));
    await settle();
    expect(shell(element).querySelectorAll(tag)).toHaveLength(1);
  });
});

describe("the shell's own listeners after a reconnect", () => {
  it("runs each click and key once after the builder was moved", async () => {
    const element = await mount();
    // One move builds the shell twice: with a copy of each listener left from the first build, one
    // click toggles twice (it ends where it began) and Cmd+S saves twice.
    reconnect(element);
    await until(() => shell(element).querySelector("[data-full-window]"));
    const builder = element.builder!;
    expect(builder.fullWindow).toBe(false);
    // One click on Full window toggles once, and the next toggles it back.
    shell(element).querySelector<HTMLElement>("[data-full-window]")!.click();
    expect(builder.fullWindow).toBe(true);
    shell(element).querySelector<HTMLElement>("[data-full-window]")!.click();
    expect(builder.fullWindow).toBe(false);
    // Cmd+S saves once.
    let saves = 0;
    builder.fileActions = { save: () => void (saves += 1) };
    builder.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, composed: true, cancelable: true }));
    expect(saves).toBe(1);
  });
});
