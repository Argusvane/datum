import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * Absent-code resilience: a lazy strip panel that arrived and was wired,
 * but whose property setter then threw, keeps what it drew; the failure is also shown: an alert
 * beside it, visible while that panel is the open one, plus `datum-error` {message, cause}.
 */
import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("a lazy panel that was wired and then threw", { timeout: 20000 }, () => {
  it("shows an alert beside the panel while it is open, and tells the host", async () => {
    const chromeModule = await import("../../../engine/form-engine/builder/web-component/builder-chrome-panel.js");
    vi.spyOn(chromeModule.DatumBuilderChromePanelElement.prototype, "textLocale", "set").mockImplementation(() => {
      throw new Error("setter broke");
    });
    const element = document.createElement("datum-form-builder");
    element.setAttribute("features", "-pdf -journeys");
    element.definition = sampleDefinition();
    const errors: Array<{ message: string; cause: unknown }> = [];
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string; cause: unknown }>).detail));
    document.body.append(element as DatumFormBuilderElement);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    const shell = element.builder!.shadowRoot!;
    shell.querySelector<HTMLButtonElement>('[data-strip] [data-panel="chrome"]')!.click();
    await until(() => shell.querySelector('[data-panel-failed="chrome"]'));
    const note = shell.querySelector<HTMLElement>('[data-panel-failed="chrome"]')!;
    expect(note.getAttribute("role")).toBe("alert");
    expect(note.textContent).toContain("Header & footer didn't load.");
    expect(note.textContent).toContain("setter broke");
    expect(note.hidden).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("Header & footer didn't load. Check the connection and try again.");
    expect((errors[0]!.cause as Error).message).toBe("setter broke");
    // Another panel open: the note goes with the panel it belongs to.
    shell.querySelector<HTMLButtonElement>('[data-strip] [data-panel="variables"]')!.click();
    await until(() => note.hidden);
    shell.querySelector<HTMLButtonElement>('[data-strip] [data-panel="chrome"]')!.click();
    await until(() => !note.hidden);
  });
});
