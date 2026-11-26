// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { FormEventType } from "../form-engine/core/events/event-types.js";
import type { SummaryEntry, SummaryState } from "../form-engine/render/live/contract.js";
import { lit } from "../form-engine/render/live/lit.js";
import { createSummaryFeature } from "../form-engine/render/live/summary.js";
import { createTabsFeature } from "../form-engine/render/live/tabs.js";
import { createBinding, definitionOf, inputOf, mounted, quiet, settled, unmountAll, wrapper } from "./live-chrome-harness.js";

/*
 * The error summary and error focus (render/live/summary.ts): the lines come
 * from the render output's entries, the renderer adds the link and the move to the control, and
 * where focus goes after a check follows the binding's `errorFocus`.
 */

afterEach(unmountAll);

const twoFields = () =>
  definitionOf([
    { id: "name", type: "text", configuration: { label: "Name", required: true } },
    { id: "email", type: "text", configuration: { label: "Email", required: true } }
  ]);

const box = (root: ShadowRoot): HTMLElement | null => root.querySelector<HTMLElement>("[data-datum-summary]");
const links = (root: ShadowRoot): HTMLAnchorElement[] => Array.from(root.querySelectorAll<HTMLAnchorElement>("[data-datum-summary] a"));

describe("the summary", () => {
  it("lists one link per blocking error under a heading counted over them, each going to its control", async () => {
    quiet();
    const m = await mounted(twoFields(), { features: [createSummaryFeature()] });
    expect(box(m.root)).toBeNull();

    await m.runtime.validate();
    await settled(m.form);
    expect(box(m.root)).not.toBeNull();
    expect(box(m.root)?.querySelector("h2")?.textContent).toBe("2 errors");
    const anchors = links(m.root);
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual([`#${inputOf(m.root, "name").id}`, `#${inputOf(m.root, "email").id}`]);
    expect(anchors.map((a) => a.textContent?.trim())).toEqual(["Name: This field is required", "Email: This field is required"]);
    // The box is the alert focus goes to; it labels itself by its heading.
    const alert = box(m.root)?.querySelector<HTMLElement>("[role=alert]");
    expect(alert?.getAttribute("tabindex")).toBe("-1");
    expect(alert?.getAttribute("aria-labelledby")).toBe(box(m.root)?.querySelector("h2")?.id);

    // Fixed: the summary goes.
    inputOf(m.root, "name").value = "Ada";
    inputOf(m.root, "name").dispatchEvent(new Event("input", { bubbles: true }));
    inputOf(m.root, "email").value = "ada@example.org";
    inputOf(m.root, "email").dispatchEvent(new Event("input", { bubbles: true }));
    await m.runtime.validate();
    await settled(m.form);
    expect(box(m.root)).toBeNull();
  });

  it("is drawn at the bottom when the form says so, and not at all when the author turned it off or in a review", async () => {
    quiet();
    const bottom = await mounted(twoFields(), { features: [createSummaryFeature()], errorPresentation: { showComponentErrors: true, showErrorSummary: true, errorSummaryPosition: "bottom" } });
    await bottom.runtime.validate();
    await settled(bottom.form);
    const placed = box(bottom.root) as HTMLElement;
    // After the last field in document order (the default puts it before the first).
    expect(wrapper(bottom.root, "email").compareDocumentPosition(placed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const top = await mounted(twoFields(), { features: [createSummaryFeature()] });
    await top.runtime.validate();
    await settled(top.form);
    expect(wrapper(top.root, "name").compareDocumentPosition(box(top.root) as HTMLElement) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();

    const off = await mounted(twoFields(), { features: [createSummaryFeature()], errorPresentation: { showComponentErrors: true, showErrorSummary: false } });
    await off.runtime.validate();
    await settled(off.form);
    expect(box(off.root)).toBeNull();

    const review = await mounted(twoFields(), { features: [createSummaryFeature()], mode: "readonly" });
    await review.runtime.validate();
    await settled(review.form);
    expect(box(review.root)).toBeNull();
  });

  it("moves focus to the control a link names, and falls back to the wrapper (reporting it) when focus does not land", async () => {
    quiet();
    const m = await mounted(twoFields(), { features: [createSummaryFeature()] });
    await m.runtime.validate();
    await settled(m.form);
    links(m.root)[1]?.click();
    expect(m.root.activeElement).toBe(inputOf(m.root, "email"));
    expect(m.errors).toEqual([]);

    // A binding whose focus target cannot take focus: the wrapper does, and the host hears of it.
    const stubborn = await mounted(twoFields(), {
      features: [createSummaryFeature()],
      binding: createBinding(lit, { focusTarget: (field) => field.querySelector("label") })
    });
    await stubborn.runtime.validate();
    await settled(stubborn.form);
    links(stubborn.root)[0]?.click();
    expect(stubborn.root.activeElement).toBe(wrapper(stubborn.root, "name"));
    expect(stubborn.errors.map((e) => e.hook)).toEqual(["focus"]);
  });

  it("hands a binding's summary the entries (href, target, focus) and its state, and falls back to Datum's when that throws", async () => {
    quiet();
    let seen: { entries: readonly SummaryEntry[]; state: SummaryState } | undefined;
    const binding = createBinding(lit, {
      summary: (entries, state) => {
        seen = { entries, state };
        return lit.html`<section class="ds-summary"><h2 id=${state.headingId}>${state.heading}</h2>${entries.map((entry) => lit.html`<a href=${entry.href} @click=${(event: Event) => { event.preventDefault(); entry.focus(); }}>${entry.text}</a>`)}</section>`;
      }
    });
    const m = await mounted(twoFields(), { binding, features: [createSummaryFeature()] });
    await m.runtime.validate();
    await settled(m.form);
    expect(seen?.entries.map((e) => [e.targetPath, e.componentId, e.label, e.message, e.href])).toEqual([
      ["name", "name", "Name", "This field is required", `#${inputOf(m.root, "name").id}`],
      ["email", "email", "Email", "This field is required", `#${inputOf(m.root, "email").id}`]
    ]);
    expect(seen?.state.heading).toBe("2 errors");
    expect(seen?.state.formEntries).toEqual([]);
    expect(seen?.state.headingId).toMatch(/__summary-heading$/);
    expect(m.root.querySelector(".ds-summary")).not.toBeNull();
    m.root.querySelector<HTMLAnchorElement>(".ds-summary a")?.click();
    expect(m.root.activeElement).toBe(inputOf(m.root, "name"));

    const broken = await mounted(twoFields(), {
      binding: createBinding(lit, {
        summary: () => {
          throw new Error("no summary");
        }
      }),
      features: [createSummaryFeature()]
    });
    await broken.runtime.validate();
    await settled(broken.form);
    expect(broken.root.querySelector(".datum-live-summary__box")).not.toBeNull();
    expect(broken.errors.some((e) => e.hook === "summary")).toBe(true);
  });

  it("heads itself a level under the form's heading level, and hands the level to a binding's summary", async () => {
    quiet();
    const m = await mounted(twoFields(), { features: [createSummaryFeature({ headingLevel: () => 3 })] });
    await m.runtime.validate();
    await settled(m.form);
    const alert = box(m.root)?.querySelector<HTMLElement>("[role=alert]");
    expect(box(m.root)?.querySelector("h4")?.textContent).toBe("2 errors");
    expect(box(m.root)?.querySelector("h2")).toBeNull();
    expect(alert?.getAttribute("aria-labelledby")).toBe(box(m.root)?.querySelector("h4")?.id);

    let level: number | undefined;
    const binding = createBinding(lit, {
      summary: (_entries, state) => {
        level = state.headingLevel;
        return lit.html`<p>${state.heading}</p>`;
      }
    });
    const bound = await mounted(twoFields(), { binding, features: [createSummaryFeature({ headingLevel: () => 2 })] });
    await bound.runtime.validate();
    await settled(bound.form);
    expect(level).toBe(3);
    // Left out, the form heads at level 1 and the summary at 2.
    const plain = await mounted(twoFields(), { binding, features: [createSummaryFeature()] });
    await plain.runtime.validate();
    await settled(plain.form);
    expect(level).toBe(2);
  });

  it("words the entries from the binding's language pack (GOV.UK style: the message alone)", async () => {
    quiet();
    const binding = createBinding(lit, { texts: { en: { summaryEntry: "{{message}}" } } });
    const m = await mounted(twoFields(), { binding, features: [createSummaryFeature()] });
    await m.runtime.validate();
    await settled(m.form);
    expect(links(m.root).map((a) => a.textContent?.trim())).toEqual(["This field is required", "This field is required"]);
  });
});

describe("error focus", () => {
  it("goes to the summary by default, and the first field in error under errorFocus 'field'", async () => {
    quiet();
    const summaryFirst = await mounted(twoFields(), { features: [createSummaryFeature()] });
    await summaryFirst.runtime.validate();
    await settled(summaryFirst.form);
    expect(summaryFirst.live().focusErrors()).toBe(true);
    expect(summaryFirst.root.activeElement).toBe(box(summaryFirst.root)?.querySelector("[role=alert]"));

    const fieldFirst = await mounted(twoFields(), { binding: createBinding(lit, { errorFocus: "field" }), features: [createSummaryFeature()] });
    await fieldFirst.runtime.validate();
    await settled(fieldFirst.form);
    expect(fieldFirst.live().focusErrors()).toBe(true);
    expect(fieldFirst.root.activeElement).toBe(inputOf(fieldFirst.root, "name"));
  });

  it("takes focusFirstError from the definition's accessibility block, and the host's setting over it", async () => {
    quiet();
    const off = definitionOf(
      [
        { id: "name", type: "text", configuration: { label: "Name", required: true } },
        { id: "email", type: "text", configuration: { label: "Email", required: true } }
      ],
      { accessibility: { focusFirstError: false } }
    );
    const binding = createBinding(lit, { errorFocus: "field" });
    const byDefinition = await mounted(off, { binding, features: [createSummaryFeature()] });
    await byDefinition.runtime.validate();
    await settled(byDefinition.form);
    expect(byDefinition.live().focusErrors()).toBe(true);
    expect(byDefinition.root.activeElement).toBe(box(byDefinition.root)?.querySelector("[role=alert]"));

    // A host that sets it itself wins: the first field takes focus, whatever the definition says.
    const byHost = await mounted(off, {
      binding,
      features: [createSummaryFeature()],
      errorPresentation: { showComponentErrors: true, showErrorSummary: true, focusFirstError: true }
    });
    await byHost.runtime.validate();
    await settled(byHost.form);
    expect(byHost.live().focusErrors()).toBe(true);
    expect(byHost.root.activeElement).toBe(inputOf(byHost.root, "name"));

    // The definition saying true changes nothing: the binding's own choice stands.
    const on = definitionOf(
      [{ id: "name", type: "text", configuration: { label: "Name", required: true } }],
      { accessibility: { focusFirstError: true } }
    );
    const kept = await mounted(on, { binding, features: [createSummaryFeature()] });
    await kept.runtime.validate();
    await settled(kept.form);
    expect(kept.live().focusErrors()).toBe(true);
    expect(kept.root.activeElement).toBe(inputOf(kept.root, "name"));
  });

  it("goes to the summary under errorFocus 'field' when the author turned focusFirstError off, and opens no tab then", async () => {
    quiet();
    const tabbed = definitionOf([
      {
        id: "t",
        type: "tabs",
        configuration: { tabs: [{ id: "one", label: "One" }, { id: "two", label: "Two" }] },
        children: {
          one: [{ id: "a", type: "text", configuration: { label: "A" } }],
          two: [{ id: "b", type: "text", configuration: { label: "B", required: true } }]
        }
      }
    ]);
    const m = await mounted(tabbed, {
      binding: createBinding(lit, { errorFocus: "field" }),
      features: [createSummaryFeature(), createTabsFeature()],
      errorPresentation: { showComponentErrors: true, showErrorSummary: true, focusFirstError: false }
    });
    await m.runtime.validate();
    await settled(m.form);
    expect(m.live().focusErrors()).toBe(true);
    expect(m.root.activeElement).toBe(box(m.root)?.querySelector("[role=alert]"));
    expect(m.root.querySelector<HTMLElement>("#t__tab-one")?.getAttribute("aria-selected")).toBe("true");
  });

  it("opens the tab holding the first error before it focuses the summary, and a field in error under 'field' focuses it inside its tab", async () => {
    quiet();
    const tabbed = () =>
      definitionOf([
        {
          id: "t",
          type: "tabs",
          configuration: { tabs: [{ id: "one", label: "One" }, { id: "two", label: "Two" }] },
          children: {
            one: [{ id: "a", type: "text", configuration: { label: "A" } }],
            two: [{ id: "b", type: "text", configuration: { label: "B", required: true } }]
          }
        }
      ]);
    const summaryFirst = await mounted(tabbed(), { features: [createSummaryFeature(), createTabsFeature()] });
    await summaryFirst.runtime.validate();
    await settled(summaryFirst.form);
    expect(summaryFirst.root.querySelector<HTMLElement>("#t__tab-one")?.getAttribute("aria-selected")).toBe("true");
    summaryFirst.live().focusErrors();
    expect(summaryFirst.root.querySelector<HTMLElement>("#t__tab-two")?.getAttribute("aria-selected")).toBe("true");
    expect(summaryFirst.root.activeElement).toBe(box(summaryFirst.root)?.querySelector("[role=alert]"));

    const fieldFirst = await mounted(tabbed(), { binding: createBinding(lit, { errorFocus: "field" }), features: [createSummaryFeature(), createTabsFeature()] });
    await fieldFirst.runtime.validate();
    await settled(fieldFirst.form);
    fieldFirst.live().focusErrors();
    expect(fieldFirst.root.querySelector<HTMLElement>("#t__tab-two")?.getAttribute("aria-selected")).toBe("true");
    expect(fieldFirst.root.activeElement).toBe(inputOf(fieldFirst.root, "b"));
  });

  it("takes the person to the errors of a submit the runtime refused, once they are drawn", async () => {
    quiet();
    const m = await mounted(twoFields(), { features: [createSummaryFeature()] });
    await m.runtime.validate();
    await settled(m.form);
    m.runtime.events().publish({ id: "e1", type: FormEventType.SUBMISSION_FAILED, timestamp: Date.now(), source: "runtime", formId: "f" });
    await settled(m.form);
    expect(m.root.activeElement).toBe(box(m.root)?.querySelector("[role=alert]"));
  });

  it("does nothing without errors, and the renderer's own first-error focus stands without a summary module", async () => {
    quiet();
    const clean = await mounted(twoFields(), { features: [createSummaryFeature()] });
    expect(clean.live().focusErrors()).toBe(false);

    const bare = await mounted(twoFields());
    await bare.runtime.validate();
    await settled(bare.form);
    expect(bare.live().focusErrors()).toBe(true);
    expect(bare.root.activeElement).toBe(inputOf(bare.root, "name"));
  });

  it("waits for a summary element that is still drawing itself, and focuses the element inside it that takes focus", async () => {
    quiet();
    const tag = "x-late-summary";
    const binding = createBinding(lit, {
      summary: (entries, state) => lit.html`<x-late-summary id="late"><span>${state.heading}</span>${entries.length}</x-late-summary>`
    });
    const m = await mounted(twoFields(), { binding, features: [createSummaryFeature()] });
    await m.runtime.validate();
    await settled(m.form);
    expect(customElements.get(tag)).toBeUndefined();
    expect(m.live().focusErrors()).toBe(true);
    // Until it is defined the wrapper has the focus.
    expect(m.root.activeElement).toBe(box(m.root));
    class LateSummary extends HTMLElement {
      connectedCallback(): void {
        const inner = document.createElement("div");
        inner.setAttribute("tabindex", "-1");
        inner.id = "inner";
        this.append(inner);
      }
    }
    customElements.define(tag, LateSummary);
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    expect(m.root.activeElement?.id).toBe("inner");
  });
});
