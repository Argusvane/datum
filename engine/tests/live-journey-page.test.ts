// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Journey } from "../form-engine/core/schema/journey.js";
import type { PageState } from "../form-engine/render/live/contract.js";
import { createJourneyPageFeature } from "../form-engine/render/live/journey-page.js";
import { lit } from "../form-engine/render/live/lit.js";
import { createSummaryFeature } from "../form-engine/render/live/summary.js";
import type { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { createBinding, definitionOf, inputOf, mounted, presses, quiet, runtimeOf, settled, type, unmountAll, wrapper } from "./live-chrome-harness.js";

/*
 * A journey page (render/live/journey-page.ts): the heading, the
 * description and the count; Continue, Back and the last page's Submit through the runtime's
 * journeyAction; an exit page that draws no Continue; busy as aria-disabled with focus kept; and
 * focus after a page change.
 */

afterEach(unmountAll);

const apply = (extra: Partial<Journey> = {}, pages?: Journey["pages"]): Journey => ({
  id: "apply",
  progress: "count",
  validation: { continue: "page" },
  pages: pages ?? [
    { id: "one", title: "About you", description: "Tell us who you are", components: ["a"] },
    { id: "two", title: "Contact", components: ["b"] }
  ],
  ...extra
});

const fields = () => [
  { id: "a", type: "text", configuration: { label: "A", required: true } },
  { id: "b", type: "text", configuration: { label: "B" } }
];

function journeyRuntime(journey: Journey, extraComponents: Array<Record<string, unknown>> = [], start: string | undefined = undefined): FormRuntime {
  const definition = definitionOf([...fields(), ...extraComponents] as never, { journey: { journeys: [journey] } });
  const runtime = runtimeOf(definition);
  runtime.startJourney("apply", start !== undefined ? { pageId: start } : {});
  return runtime;
}

const heading = (root: ShadowRoot): HTMLElement | null => root.querySelector<HTMLElement>("[data-journey-heading]");
const continueButton = (root: ShadowRoot): HTMLButtonElement | null => root.querySelector<HTMLButtonElement>("[data-journey-continue]");
const backButton = (root: ShadowRoot): HTMLButtonElement | null => root.querySelector<HTMLButtonElement>("[data-journey-back]");
const drawnIds = (root: ShadowRoot): string[] => Array.from(root.querySelectorAll(".datum-live-field")).map((e) => e.getAttribute("data-component-id") as string);

function features() {
  const page = createJourneyPageFeature();
  return { page, list: [createSummaryFeature(), page] };
}

describe("a journey page: what it draws", () => {
  it("draws the page's heading with its count, its description, its own components alone, and Continue without Back on the first page", async () => {
    quiet();
    const { list } = features();
    const m = await mounted(m0(), { runtime: journeyRuntime(apply()), features: list });
    expect(heading(m.root)?.textContent).toContain("Step 1 of 2");
    expect(heading(m.root)?.textContent).toContain("About you");
    expect(heading(m.root)?.id).toBe("one__page-heading");
    expect(heading(m.root)?.getAttribute("tabindex")).toBe("-1");
    expect(m.root.querySelector(".datum-form__journey-description")?.textContent).toBe("Tell us who you are");
    expect(drawnIds(m.root)).toEqual(["a"]);
    expect(continueButton(m.root)?.textContent).toBe("Continue");
    expect(continueButton(m.root)?.getAttribute("aria-disabled")).toBe("false");
    expect(backButton(m.root)).toBeNull();
    // Start leaves focus where it is.
    expect(m.root.activeElement).toBeNull();
    // The form is no focus place of its own while a heading is drawn.
    expect(m.root.querySelector("form")?.hasAttribute("data-journey-page-focus")).toBe(false);
  });

  it("draws Submit on the last page, Back on every page after the first, and no Continue on an exit page", async () => {
    quiet();
    const { list } = features();
    const m = await mounted(m0(), { runtime: journeyRuntime(apply(), [], undefined), features: list });
    inputOf(m.root, "a");
    type(inputOf(m.root, "a"), "Ada");
    continueButton(m.root)?.click();
    await settled(m.form);
    expect(drawnIds(m.root)).toEqual(["b"]);
    expect(continueButton(m.root)?.textContent).toBe("Submit");
    expect(backButton(m.root)?.textContent).toBe("Back");

    const exit = journeyRuntime(apply({}, [{ id: "one", title: "Question", components: ["a"], routes: [{ to: "bye" }] }, { id: "bye", title: "Not eligible", kind: "exit", components: [] }]));
    const e = await mounted(m0(), { runtime: exit, features: features().list });
    type(inputOf(e.root, "a"), "Ada");
    continueButton(e.root)?.click();
    await settled(e.form);
    expect(heading(e.root)?.textContent).toBe("Not eligible");
    expect(continueButton(e.root)).toBeNull();
    expect(backButton(e.root)).not.toBeNull();
    // Enter has nothing to do on it, and the count does not include it.
    expect(heading(e.root)?.querySelector(".datum-form__journey-progress")).toBeNull();
  });

  it("draws no heading for a journey that hides it: the description alone, and the form is the place focus goes", async () => {
    quiet();
    const m = await mounted(m0(), { runtime: journeyRuntime(apply({ heading: "hidden" })), features: features().list });
    expect(heading(m.root)).toBeNull();
    expect(m.root.querySelector(".datum-form__journey-description")?.textContent).toBe("Tell us who you are");
    const form = m.root.querySelector("form") as HTMLFormElement;
    expect(form.hasAttribute("data-journey-page-focus")).toBe(true);
    expect(form.getAttribute("tabindex")).toBe("-1");

    type(inputOf(m.root, "a"), "Ada");
    continueButton(m.root)?.click();
    await settled(m.form);
    expect(drawnIds(m.root)).toEqual(["b"]);
    expect(m.root.activeElement).toBe(form);
  });

  it("hands a binding's page hooks the page's state, and falls back to Datum's when they throw", async () => {
    quiet();
    const seen: PageState[] = [];
    const binding = createBinding(lit, {
      page: {
        heading: (p) => (seen.push(p), lit.html`<h1 class="ds-heading" id=${p.headingId} tabindex="-1">${p.title}</h1>`),
        actions: (p) => lit.html`<div class="ds-actions">${p.back ? lit.html`<button id="ds-back" @click=${p.back}>${p.backLabel}</button>` : lit.nothing}${p.next ? lit.html`<button id="ds-next" @click=${p.next}>${p.nextLabel}</button>` : lit.nothing}</div>`
      }
    });
    const m = await mounted(m0(), { runtime: journeyRuntime(apply()), binding, features: features().list });
    expect(seen[0]).toMatchObject({ journeyId: "apply", pageId: "one", title: "About you", description: "Tell us who you are", headingId: "one__page-heading", backLabel: "Back", nextLabel: "Continue", final: false, busy: false });
    expect(seen[0]?.progress).toBe("Step 1 of 2");
    expect(seen[0]?.back).toBeUndefined();
    expect(seen[0]?.next).toBeTypeOf("function");
    type(inputOf(m.root, "a"), "Ada");
    (m.root.getElementById("ds-next") as HTMLButtonElement).click();
    await settled(m.form);
    expect(seen[seen.length - 1]).toMatchObject({ pageId: "two", final: true, nextLabel: "Submit" });
    expect(seen[seen.length - 1]?.back).toBeTypeOf("function");
    // Focus goes to the id the binding was told to put on its heading.
    expect(m.root.activeElement).toBe(m.root.querySelector(".ds-heading"));
    (m.root.getElementById("ds-back") as HTMLButtonElement).click();
    await settled(m.form);
    expect(drawnIds(m.root)).toEqual(["a"]);

    const broken = await mounted(m0(), {
      runtime: journeyRuntime(apply()),
      binding: createBinding(lit, {
        page: {
          heading: () => {
            throw new Error("no heading");
          },
          actions: () => {
            throw new Error("no actions");
          }
        }
      }),
      features: features().list
    });
    expect(heading(broken.root)?.textContent).toContain("About you");
    expect(continueButton(broken.root)).not.toBeNull();
    expect(broken.errors.map((e) => e.hook).sort()).toEqual(["page.actions", "page.heading"]);
  });
});

describe("a journey page: Continue, Back, Submit", () => {
  it("refuses Continue with errors, drawing them and taking the person to them; accepts it once fixed and focuses the new page's heading", async () => {
    quiet();
    const m = await mounted(m0(), { runtime: journeyRuntime(apply()), features: features().list });
    continueButton(m.root)?.click();
    await settled(m.form);
    expect(drawnIds(m.root)).toEqual(["a"]);
    expect(wrapper(m.root, "a").hasAttribute("data-invalid")).toBe(true);
    expect(m.root.querySelector("[data-datum-summary]")).not.toBeNull();
    expect(m.root.activeElement).toBe(m.root.querySelector("[data-datum-summary] [role=alert]"));

    type(inputOf(m.root, "a"), "Ada");
    continueButton(m.root)?.click();
    await settled(m.form);
    expect(drawnIds(m.root)).toEqual(["b"]);
    expect(m.root.querySelector("[data-datum-summary]")).toBeNull();
    expect(m.root.activeElement).toBe(heading(m.root));

    backButton(m.root)?.click();
    await settled(m.form);
    expect(drawnIds(m.root)).toEqual(["a"]);
    expect(m.root.activeElement).toBe(heading(m.root));
    expect(inputOf(m.root, "a").value).toBe("Ada");
  });

  it("reports the last page's Submit as datum-form-action with the journey, and does not submit by itself", async () => {
    quiet();
    const runtime = journeyRuntime(apply());
    const submit = vi.spyOn(runtime, "submit");
    const m = await mounted(m0(), { runtime, features: features().list });
    type(inputOf(m.root, "a"), "Ada");
    continueButton(m.root)?.click();
    await settled(m.form);
    continueButton(m.root)?.click();
    await settled(m.form);
    expect(m.events("datum-form-action").map((e) => e.detail)).toEqual([{ componentId: "root", action: "submit", journey: { journeyId: "apply", pageId: "two" } }]);
    expect(submit).not.toHaveBeenCalled();
  });

  it("leaves the last page's action to a submit button of its own: no Submit drawn, and Enter in a box presses that button", async () => {
    quiet();
    const own = { id: "send", type: "button", configuration: { label: "Send it", action: "submit" } };
    const journey = apply({}, [{ id: "one", title: "One", components: ["a"] }, { id: "two", title: "Two", components: ["b", "send"] }]);
    const m = await mounted(definitionOf([...fields(), own] as never, { journey: { journeys: [journey] } }), { runtime: journeyRuntime(journey, [own]), features: features().list });
    type(inputOf(m.root, "a"), "Ada");
    continueButton(m.root)?.click();
    await settled(m.form);
    expect(continueButton(m.root)).toBeNull();
    expect(wrapper(m.root, "send")).not.toBeNull();
    const box = inputOf(m.root, "b");
    box.focus();
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true, cancelable: true }));
    await settled(m.form);
    expect(presses).toEqual(["send"]);
    expect(m.events("datum-form-action")).toHaveLength(0);
  });

  it("does what Continue does on Enter in a text box, and ignores Enter elsewhere", async () => {
    quiet();
    const m = await mounted(m0(), { runtime: journeyRuntime(apply()), features: features().list });
    type(inputOf(m.root, "a"), "Ada");
    const enter = (target: Element, init: KeyboardEventInit = {}): KeyboardEvent => {
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    };
    const shifted = enter(inputOf(m.root, "a"), { shiftKey: true });
    expect(shifted.defaultPrevented).toBe(false);
    const onButton = enter(continueButton(m.root) as HTMLElement);
    expect(onButton.defaultPrevented).toBe(false);
    await settled(m.form);
    expect(drawnIds(m.root)).toEqual(["a"]);
    const pressed = enter(inputOf(m.root, "a"));
    expect(pressed.defaultPrevented).toBe(true);
    await settled(m.form);
    expect(drawnIds(m.root)).toEqual(["b"]);
  });
});

describe("a journey page: busy", () => {
  it("draws aria-disabled while a Continue is out, ignores a second press, and puts focus back on the button if it was lost", async () => {
    quiet();
    const runtime = journeyRuntime(apply());
    let release: (() => void) | undefined;
    const original = runtime.journeyAction.bind(runtime);
    const calls: number[] = [];
    vi.spyOn(runtime, "journeyAction").mockImplementation(async (page) => {
      calls.push(1);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { kind: "idle" } as Awaited<ReturnType<typeof original>>;
    });
    const m = await mounted(m0(), { runtime, features: features().list });
    const pressed = continueButton(m.root) as HTMLButtonElement;
    pressed.focus();
    pressed.click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(m.root.querySelector("form")?.getAttribute("aria-busy")).toBe("true");
    expect(continueButton(m.root)?.getAttribute("aria-disabled")).toBe("true");
    // Never disabled: the button keeps what it was pressed with.
    expect(continueButton(m.root)?.disabled).toBe(false);
    expect(continueButton(m.root)).toBe(pressed);
    continueButton(m.root)?.click();
    expect(calls).toHaveLength(1);
    // A design system's button that could only be disabled lost the focus meanwhile.
    pressed.blur();
    release?.();
    await settled(m.form);
    expect(m.root.querySelector("form")?.hasAttribute("aria-busy")).toBe(false);
    expect(continueButton(m.root)?.getAttribute("aria-disabled")).toBe("false");
    expect(m.root.activeElement).toBe(pressed);
  });

  it("draws the page busy while the host's server checks it, with the checking line", async () => {
    quiet();
    const journey = apply({}, [{ id: "one", title: "One", components: ["a"], validation: { server: true } }, { id: "two", title: "Two", components: ["b"] }]);
    const runtime = journeyRuntime(journey);
    let answer: ((verdict: { ok: boolean; errors?: never[] }) => void) | undefined;
    runtime.setJourneyServerValidator((() =>
      new Promise((resolve) => {
        answer = resolve as typeof answer;
      })) as never);
    const m = await mounted(m0(), { runtime, features: features().list });
    type(inputOf(m.root, "a"), "Ada");
    continueButton(m.root)?.click();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await m.form.updated();
    expect(m.root.querySelector(".datum-form__journey-checking")?.textContent).toContain("Checking");
    expect(continueButton(m.root)?.getAttribute("aria-disabled")).toBe("true");
    answer?.({ ok: true });
    await settled(m.form);
    expect(m.root.querySelector(".datum-form__journey-checking")).toBeNull();
  });
});

describe("a journey page: focus after a page change", () => {
  it("moves focus to the heading for a move the runtime makes, and to the errors for a move to the page holding them", async () => {
    quiet();
    const runtime = journeyRuntime(apply());
    const m = await mounted(m0(), { runtime, features: features().list });
    type(inputOf(m.root, "a"), "Ada");
    await runtime.nextPage();
    await settled(m.form);
    expect(m.root.activeElement).toBe(heading(m.root));

    // Back to the page with the error: where the error is.
    type(inputOf(m.root, "b"), "x");
    runtime.setValue("a", "");
    await runtime.validate();
    await settled(m.form);
    await runtime.goToPage("one", { direction: "error" });
    await settled(m.form);
    expect(drawnIds(m.root)).toEqual(["a"]);
    expect(m.root.activeElement).toBe(m.root.querySelector("[data-datum-summary] [role=alert]"));
  });

  it("moves nothing for a move made quietly (an agent's), once, and releases the quiet if the move never came", async () => {
    quiet();
    const runtime = journeyRuntime(apply());
    const set = features();
    const m = await mounted(m0(), { runtime, features: set.list });
    runtime.setValue("a", "Ada");
    const release = set.page.quietNextPageFocus();
    await runtime.nextPage();
    release();
    await settled(m.form);
    expect(drawnIds(m.root)).toEqual(["b"]);
    expect(m.root.activeElement).toBeNull();

    // The quiet was used up: the next move takes focus as usual.
    await runtime.previousPage();
    await settled(m.form);
    expect(m.root.activeElement).toBe(heading(m.root));

    // A quiet that was never used is released, and cannot swallow a later move.
    const unused = set.page.quietNextPageFocus();
    unused();
    await runtime.nextPage();
    await settled(m.form);
    expect(m.root.activeElement).toBe(heading(m.root));
  });

  it("keeps focus where it is when the journey starts again", async () => {
    quiet();
    const runtime = journeyRuntime(apply());
    const m = await mounted(m0(), { runtime, features: features().list });
    type(inputOf(m.root, "a"), "Ada");
    await runtime.nextPage();
    await settled(m.form);
    (m.root.activeElement as HTMLElement).blur();
    runtime.startJourney("apply");
    await settled(m.form);
    expect(drawnIds(m.root)).toEqual(["a"]);
    expect(m.root.activeElement).toBeNull();
  });

  it("falls back to the form, reporting it, when the binding's heading cannot take focus", async () => {
    quiet();
    const binding = createBinding(lit, { page: { heading: (p) => lit.html`<h2 id=${p.headingId}>${p.title}</h2>`, actions: (p) => lit.html`<button id="next" @click=${() => p.next?.()}>${p.nextLabel}</button>` } });
    const runtime = journeyRuntime(apply());
    const m = await mounted(m0(), { runtime, binding, features: features().list });
    type(inputOf(m.root, "a"), "Ada");
    (m.root.getElementById("next") as HTMLButtonElement).click();
    await settled(m.form);
    expect(m.root.activeElement).toBe(m.root.querySelector("form"));
    expect(m.errors.map((e) => e.hook)).toContain("focus");
  });
});

/** The definition the mounts share: the journey runtime carries the real one. */
function m0() {
  return definitionOf(fields() as never);
}
