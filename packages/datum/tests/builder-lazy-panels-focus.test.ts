import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The Variables panel's Retry keeps focus in the drawer. This test has a file of its
 * own because it needs the panel's element to be undefined when the load fails: a Retry card is
 * focusable only while its host has no shadow root. Once a test in a file has loaded the chunk
 * the tag stays defined, the card sits in the light DOM of an upgraded host with no slot to draw
 * it, and jsdom (since 30) rightly keeps it out of the flat tree and refuses it focus, as a
 * browser does. In the page the chunk's fetch is not repeated once the tag is defined, so that
 * state never meets a Retry card. The loader is wrapped to fail once and to hold one on demand.
 */
type Gate = { promise: Promise<void>; open(): void };
const gateOf = (): Gate => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};
const fetches = vi.hoisted(() => ({
  variables: 0,
  failVariables: 0,
  holdVariables: undefined as Promise<void> | undefined
}));

vi.mock("../../../engine/form-engine/builder/web-component/variables-panel-loader.js", async (importOriginal) => {
  const actual = await importOriginal<{ loadVariablesPanel(): Promise<unknown> }>();
  return {
    ...actual,
    loadVariablesPanel: async () => {
      fetches.variables += 1;
      if (fetches.failVariables > 0) {
        fetches.failVariables -= 1;
        throw new Error("offline");
      }
      await fetches.holdVariables;
      return actual.loadVariablesPanel();
    }
  };
});

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

beforeEach(() => {
  Object.assign(fetches, { variables: 0, failVariables: 0, holdVariables: undefined });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function mount(): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.setAttribute("pdf", "off");
  element.definition = sampleDefinition();
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return element;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const host = (element: DatumFormBuilderElement, tag: string): HTMLElement => shell(element).querySelector<HTMLElement>(tag)!;
const stripItem = (element: DatumFormBuilderElement, panel: string): HTMLButtonElement =>
  shell(element).querySelector<HTMLButtonElement>(`[data-strip] [data-panel="${panel}"]`)!;

describe("the lazy Variables panel's focus", () => {
  it("keeps focus in the drawer across a Retry: on the loading card, then in the panel", async () => {
    fetches.failVariables = 1;
    const gate = gateOf();
    const element = await mount();
    const panel = host(element, "datum-builder-variables-panel");
    stripItem(element, "variables").click();
    await until(() => panel.querySelector("[data-panel-retry]"));
    const retry = panel.querySelector<HTMLButtonElement>("[data-panel-retry]")!;
    retry.focus();
    expect(shell(element).activeElement).toBe(retry);

    fetches.holdVariables = gate.promise;
    retry.click();
    // The Retry button is gone; focus moved to the loading card, not to the body.
    const card = panel.querySelector<HTMLElement>('[role="status"]')!;
    expect(card.getAttribute("tabindex")).toBe("-1");
    expect(shell(element).activeElement).toBe(card);
    // Escape from there still reaches the shell: the card is inside the shell's root.
    gate.open();
    await until(() => panel.shadowRoot?.querySelector(".variables-head"));
    expect(shell(element).activeElement).toBe(panel);
    expect(panel.shadowRoot!.activeElement).toBe(panel.shadowRoot!.querySelector(".variables-head"));
  });
});
