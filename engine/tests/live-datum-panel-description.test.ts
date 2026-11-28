// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { definitionOf, quiet, unmountAll } from "./live-chrome-harness.js";
import { mountDatum } from "./live-datum-kit.js";

/*
 * A panel's description stays in sight when its label is hidden (hiding the label hides the
 * label only), and the section is described by it.
 */

afterEach(unmountAll);

const panel = (configuration: Record<string, unknown>) =>
  definitionOf([{ id: "card", type: "panel", configuration, children: { content: [{ id: "a", type: "text", configuration: { label: "A" } }] } }] as never);

const descriptionOf = (root: ShadowRoot): HTMLElement => root.querySelector(".datum-form__group-description") as HTMLElement;

describe("panel: the description", () => {
  it("keeps the description visible when only the label is hidden", async () => {
    quiet();
    const m = await mountDatum(panel({ label: "Your details", description: "We use these to contact you", hideLabel: true }));
    const description = descriptionOf(m.root);
    expect(description?.textContent).toBe("We use these to contact you");
    expect(description.closest(".datum-form__visually-hidden")).toBeNull();
    // The heading is still there for a screen reader, visually hidden.
    expect(m.root.querySelector(".datum-form__panel-title")?.closest(".datum-form__visually-hidden")).not.toBeNull();
    const section = m.root.querySelector("section.datum-form__panel") as HTMLElement;
    expect(section.getAttribute("aria-labelledby")).toBe("card__group-label");
    expect(section.getAttribute("aria-describedby")).toBe(description.id);
  });

  it("describes a labelled panel by its description, under its visible heading", async () => {
    quiet();
    const m = await mountDatum(panel({ label: "Your details", description: "We use these to contact you" }));
    const description = descriptionOf(m.root);
    expect(description.closest(".datum-form__panel-header")).not.toBeNull();
    expect(m.root.querySelector("section.datum-form__panel")?.getAttribute("aria-describedby")).toBe(description.id);
  });

  it("is described by nothing where the design system's groups are described by nothing", async () => {
    quiet();
    const m = await mountDatum(panel({ label: "Your details", description: "We use these to contact you" }), { containers: { controls: { groupDescription: "none" } } });
    expect(m.root.querySelector("section.datum-form__panel")?.hasAttribute("aria-describedby")).toBe(false);
  });
});
