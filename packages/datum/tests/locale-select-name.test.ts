import { describe, expect, it } from "vitest";
import "../src/index.js";

describe("the locale select", () => {
  it("has an accessible name as well as a title", () => {
    const el = document.createElement("datum-locale-select") as HTMLElement & { locales: unknown };
    el.setAttribute("label", "Language");
    el.locales = [{ code: "en", label: "English" }, { code: "fr", label: "Français" }];
    document.body.append(el);
    const select = el.shadowRoot!.querySelector("select")!;
    expect(select.getAttribute("aria-label")).toBe("Language");
    expect(select.getAttribute("title")).toBe("Language");
  });

  it("is named by a visible label when show-label is set", () => {
    const el = document.createElement("datum-locale-select") as HTMLElement & { locales: unknown };
    el.setAttribute("label", "Show the form in");
    el.setAttribute("show-label", "");
    el.locales = [{ code: "en", label: "English" }];
    document.body.append(el);
    const root = el.shadowRoot!;
    const label = root.querySelector("label")!;
    const select = root.querySelector("select")!;
    expect(label.textContent).toBe("Show the form in");
    expect(label.getAttribute("for")).toBe(select.id);
    expect(select.getAttribute("aria-labelledby")).toBe(label.id);
    expect(select.hasAttribute("aria-label")).toBe(false);
  });
});
