// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { rovingToolbar } from "../form-engine/builder/web-component/toolbar-roving.js";

function bar(count: number): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = Array.from({ length: count }, (_, index) => `<button type="button" data-n="${index}">${index}</button>`).join("");
  return el;
}

const stops = (el: HTMLElement): string[] => [...el.querySelectorAll("button")].filter((button) => button.getAttribute("tabindex") === "0").map((button) => button.dataset.n!);

describe("rovingToolbar", () => {
  afterEach(() => {
    delete (HTMLElement.prototype as { checkVisibility?: unknown }).checkVisibility;
    document.body.innerHTML = "";
  });

  it("keeps one Tab stop on a bar that is not laid out yet (a browser reports every tool as not visible)", () => {
    // Chrome's rule: an element with no box is not visible, a disconnected one included.
    (HTMLElement.prototype as { checkVisibility?: () => boolean }).checkVisibility = function (this: HTMLElement) {
      return this.isConnected;
    };
    const el = bar(4);
    rovingToolbar(el);
    expect(stops(el)).toEqual(["0"]);
  });

  it("moves with the arrows, wraps, and skips a hidden or disabled tool", () => {
    const el = bar(4);
    document.body.append(el);
    el.querySelectorAll("button")[1]!.hidden = true;
    el.querySelectorAll("button")[2]!.disabled = true;
    rovingToolbar(el);
    const first = el.querySelector<HTMLElement>('[data-n="0"]')!;
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(stops(el)).toEqual(["3"]);
    el.querySelector<HTMLElement>('[data-n="3"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(stops(el)).toEqual(["0"]);
  });

  it("gives the stop to another tool when the one holding it is hidden", async () => {
    const el = bar(3);
    document.body.append(el);
    rovingToolbar(el);
    el.querySelector<HTMLElement>('[data-n="0"]')!.hidden = true;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stops(el)).toEqual(["1"]);
  });
});
