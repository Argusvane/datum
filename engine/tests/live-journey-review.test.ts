// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { ReviewState } from "../form-engine/render/live/contract.js";
import { createDatumBinding, createDatumFeatures } from "../form-engine/render/live/datum/options.js";
import { EagerJourneyReviewKit } from "../form-engine/render/core/journey-review-kit-eager.js";
import { createJourneyPageFeature } from "../form-engine/render/live/journey-page.js";
import { REVIEW_CSS } from "../form-engine/render/live/journey-review.js";
import { lit } from "../form-engine/render/live/lit.js";
import type { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { homeDefinition, toCheck } from "./journey-review-fixture.js";
import { mounted, quiet, runtimeOf, settled, unmountAll, type Mounted } from "./live-chrome-harness.js";

/*
 * A journey's Check answers page in the live form (render/live/journey-review.ts): Datum's
 * drawing of the list (headings, rows, cards, hidden words), Change and Enter through the runtime
 * with focus on the step's heading and, on the way back, on the row changed; the error summary's
 * links to the rows after a refused send; a binding's `review` hook.
 */

afterEach(unmountAll);

const envelope = {
  form: { id: "f", version: "1" },
  client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1" }
};

async function onCheck(runtime: FormRuntime = runtimeOf(homeDefinition()), binding = createDatumBinding()): Promise<Mounted> {
  await toCheck(runtime);
  const m = await mounted(homeDefinition(), { runtime, binding, features: [...createDatumFeatures(), createJourneyPageFeature(EagerJourneyReviewKit)] });
  await settled(m.form);
  return m;
}

const review = (root: ShadowRoot): HTMLElement => root.querySelector<HTMLElement>("[data-journey-review]") as HTMLElement;
const rowOf = (root: ShadowRoot, key: string): HTMLElement => root.getElementById(`check__review-${key}`) as HTMLElement;
const linkIn = (element: HTMLElement): HTMLAnchorElement => element.querySelector("a[href]") as HTMLAnchorElement;
const text = (element: Element | null | undefined): string => (element?.textContent ?? "").replace(/\s+/g, " ").trim();
const heading = (root: ShadowRoot): HTMLElement | null => root.querySelector<HTMLElement>("[data-journey-heading]");

describe("a Check answers page: Datum's drawing", () => {
  it("draws the count and the page's heading, a heading per step, the answers as description lists, then the page's own content and Submit", async () => {
    quiet();
    const m = await onCheck();
    expect(text(heading(m.root))).toBe("Step 5 of 5: Check your answers before sending your application");
    expect(heading(m.root)?.tagName).toBe("H1");
    const list = review(m.root);
    expect([...list.querySelectorAll(".datum-form__review-heading")].map((h) => [h.tagName, text(h)])).toEqual([
      ["H2", "Your home"],
      ["H2", "Owning or renting"],
      ["H2", "Your landlord"],
      ["H2", "Work needed"]
    ]);
    // Rows are a dt and its dd in a dl.
    const main = rowOf(m.root, "main");
    expect(main.parentElement?.tagName).toBe("DL");
    expect(text(main.querySelector("dt"))).toBe("Is this your main home?");
    expect(text(main.querySelector(".datum-form__review-value"))).toBe("Yes");
    // The address keeps its line.
    expect(rowOf(m.root, "address").querySelector(".datum-form__review-value br")).not.toBeNull();
    expect(text(rowOf(m.root, "cost").querySelector(".datum-form__review-value"))).toBe("Not provided");
    // The page's own content (the declaration) after the list, then Submit.
    const declaration = m.root.querySelector('[data-component-id="declare"]');
    expect(declaration).not.toBeNull();
    expect(list.compareDocumentPosition(declaration as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(text(m.root.querySelector("[data-journey-continue]"))).toBe("Submit");
    expect(m.root.querySelector("[data-journey-back]")).not.toBeNull();
    expect(m.errors).toEqual([]);
  });

  it("names each Change link by its row with visually hidden words, and puts an Enter link in a missing answer's place", async () => {
    quiet();
    const m = await onCheck();
    const change = linkIn(rowOf(m.root, "main"));
    expect(change.closest("dd")?.classList.contains("datum-form__review-actions")).toBe(true);
    expect(text(change)).toBe("Change Is this your main home?");
    expect(text(change.querySelector(".datum-form__visually-hidden"))).toBe("Is this your main home?");
    expect(change.getAttribute("href")).toBe("#home__page-heading");
    const landlord = rowOf(m.root, "landlord");
    expect(landlord.querySelector(".datum-form__review-actions")).toBeNull();
    expect(landlord.classList.contains("datum-form__review-row--no-actions")).toBe(true);
    expect(text(linkIn(landlord))).toBe("Enter Landlord's name");
    expect(linkIn(landlord).closest("dd")?.classList.contains("datum-form__review-value")).toBe(true);
  });

  it("draws a data grid's rows as cards: the row heading as the card's title, one Change, the fields as rows", async () => {
    quiet();
    const m = await onCheck();
    const card = m.root.getElementById("check__review-people[0]") as HTMLElement;
    expect(card.classList.contains("datum-form__review-card")).toBe(true);
    expect(card.querySelector(".datum-form__review-card-title")?.tagName).toBe("H3");
    expect(text(card.querySelector(".datum-form__review-card-title"))).toBe("Person 1");
    expect(card.querySelectorAll("a[href]")).toHaveLength(1);
    expect(text(linkIn(card))).toBe("Change Person 1");
    expect([...card.querySelectorAll("dt")].map(text)).toEqual(["Name", "Date of birth"]);
    expect(text(rowOf(m.root, "people[1].dob").querySelector("dd"))).toBe("July 19, 2015");
  });

  it("adopts its own rules into the form's root, and takes them away on unmount", async () => {
    quiet();
    const m = await onCheck();
    const css = (): string => Array.from((m.root.adoptedStyleSheets ?? []) as Iterable<CSSStyleSheet>).flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).join("\n") + [...m.root.querySelectorAll("style")].map((s) => s.textContent).join("\n");
    expect(css()).toContain(".datum-form__review-row");
    expect(REVIEW_CSS).toContain(".datum-form__review-card");
    m.form.unmount();
    expect(css()).not.toContain(".datum-form__review-row");
  });
});

describe("a Check answers page: Change, Enter and the way back", () => {
  it("Change opens the step, focus on its heading; Continue comes back, focus on the row changed", async () => {
    quiet();
    const m = await onCheck();
    linkIn(rowOf(m.root, "agreed")).click();
    await settled(m.form);
    expect(m.runtime.journeyView()).toMatchObject({ pageId: "landlord", returning: { reviewPageId: "check", nextPageId: "check" } });
    expect(m.root.activeElement).toBe(m.root.getElementById("landlord__page-heading"));
    m.runtime.setValue("landlord", "Sam Lee");
    (m.root.querySelector("[data-journey-continue]") as HTMLButtonElement).click();
    await settled(m.form);
    expect(m.runtime.journeyView()?.pageId).toBe("check");
    expect(m.root.activeElement).toBe(linkIn(rowOf(m.root, "agreed")));
    // The answer typed on the way is listed.
    expect(text(rowOf(m.root, "landlord").querySelector(".datum-form__review-value"))).toBe("Sam Lee");
  });

  it("Enter goes to the missing answer's step the same way; Back comes back too", async () => {
    quiet();
    const m = await onCheck();
    linkIn(rowOf(m.root, "landlord")).click();
    await settled(m.form);
    expect(m.runtime.journeyView()?.pageId).toBe("landlord");
    expect(m.runtime.state().journey?.returnTo).toBe("check");
    (m.root.querySelector("[data-journey-back]") as HTMLButtonElement).click();
    await settled(m.form);
    expect(m.runtime.journeyView()?.pageId).toBe("check");
    expect(m.root.activeElement).toBe(linkIn(rowOf(m.root, "landlord")));
  });

  it("a card's Change comes back to the card", async () => {
    quiet();
    const m = await onCheck();
    linkIn(m.root.getElementById("check__review-people[1]") as HTMLElement).click();
    await settled(m.form);
    expect(m.runtime.journeyView()?.pageId).toBe("home");
    (m.root.querySelector("[data-journey-continue]") as HTMLButtonElement).click();
    await settled(m.form);
    expect(m.root.activeElement).toBe(linkIn(m.root.getElementById("check__review-people[1]") as HTMLElement));
  });

  it("a changed answer that puts a new step on the path visits it before coming back, and the list takes it in", async () => {
    quiet();
    const again = runtimeOf(homeDefinition());
    await toCheck(again);
    // Owning: the landlord's step leaves the path.
    again.setValue("tenure", "own");
    const n = await mounted(homeDefinition(), { runtime: again, binding: createDatumBinding(), features: [...createDatumFeatures(), createJourneyPageFeature(EagerJourneyReviewKit)] });
    await settled(n.form);
    expect(rowOf(n.root, "landlord")).toBeNull();
    linkIn(rowOf(n.root, "tenure")).click();
    await settled(n.form);
    expect(again.journeyView()?.pageId).toBe("owning");
    again.setValue("tenure", "rent");
    (n.root.querySelector("[data-journey-continue]") as HTMLButtonElement).click();
    await settled(n.form);
    // The step the new answer put on the path, its heading focused.
    expect(again.journeyView()).toMatchObject({ pageId: "landlord", returning: { reviewPageId: "check", nextPageId: "check" } });
    expect(n.root.activeElement).toBe(n.root.getElementById("landlord__page-heading"));
    again.setValue("landlord", "Sam Lee");
    (n.root.querySelector("[data-journey-continue]") as HTMLButtonElement).click();
    await settled(n.form);
    expect(again.journeyView()?.pageId).toBe("check");
    expect(text(rowOf(n.root, "landlord").querySelector(".datum-form__review-value"))).toBe("Sam Lee");
    expect(n.root.activeElement).toBe(linkIn(rowOf(n.root, "tenure")));
  });
});

describe("a Check answers page: the way back forgotten", () => {
  it("forgets the row a Change left once the person moves off the way back: a later arrival focuses the heading", async () => {
    quiet();
    const m = await onCheck();
    linkIn(rowOf(m.root, "agreed")).click();
    await settled(m.form);
    expect(m.runtime.journeyView()?.pageId).toBe("landlord");
    // A jump elsewhere ends the way back.
    expect((await m.runtime.goToPage("home")).ok).toBe(true);
    await settled(m.form);
    expect(m.runtime.journeyView()?.returning).toBeUndefined();
    m.runtime.setValue("landlord", "Sam Lee");
    for (const next of ["owning", "landlord", "work", "check"]) {
      expect((await m.runtime.nextPage()).pageId).toBe(next);
      await settled(m.form);
    }
    expect(m.root.activeElement).toBe(heading(m.root));
  });
});

describe("a Check answers page in a form that is not interactive", () => {
  it("draws the answers with no Change or Enter link when the form is disabled", async () => {
    quiet();
    const runtime = runtimeOf(homeDefinition());
    await toCheck(runtime);
    const m = await mounted(homeDefinition(), { runtime, binding: createDatumBinding(), features: [...createDatumFeatures(), createJourneyPageFeature(EagerJourneyReviewKit)], mode: "disabled" });
    await settled(m.form);
    const list = review(m.root);
    expect(text(rowOf(m.root, "main").querySelector(".datum-form__review-value"))).toBe("Yes");
    expect(list.querySelectorAll("a").length).toBe(0);
    expect(rowOf(m.root, "landlord").getAttribute("data-status")).toBe("missing");
  });
});

describe("a Check answers page: its rules and the host's", () => {
  it("adopts its rules ahead of the root's sheets, so the host's extra sheet stays last", async () => {
    quiet();
    const runtime = runtimeOf(homeDefinition());
    await toCheck(runtime);
    expect((await runtime.goToPage("work")).ok).toBe(true);
    const m = await mounted(homeDefinition(), { runtime, binding: createDatumBinding(), features: [...createDatumFeatures(), createJourneyPageFeature(EagerJourneyReviewKit)] });
    await settled(m.form);
    // The host's extra rules, adopted last after the form's (as the element does).
    const extra = new CSSStyleSheet();
    extra.replaceSync(".datum-form__review-key { color: red; }");
    m.root.adoptedStyleSheets = [...m.root.adoptedStyleSheets, extra];
    expect((await runtime.nextPage()).pageId).toBe("check");
    await settled(m.form);
    expect(review(m.root)).not.toBeNull();
    const sheets = m.root.adoptedStyleSheets;
    const own = sheets.findIndex((sheet) => [...sheet.cssRules].some((rule) => rule.cssText.includes(".datum-form__review-row")));
    expect(own).toBeGreaterThanOrEqual(0);
    expect(sheets[sheets.length - 1]).toBe(extra);
    expect(own).toBeLessThan(sheets.indexOf(extra));
  });
});

describe("a Check answers page: a blocked send", () => {
  it("stays on the page; the summary lists the errors, each linking to its row, and the row shows its error", async () => {
    quiet();
    const m = await onCheck();
    const result = await m.runtime.submit("submit", envelope);
    expect(result.accepted).toBe(false);
    await settled(m.form);
    expect(m.runtime.journeyView()?.pageId).toBe("check");
    const summary = m.root.querySelector("[data-datum-summary]") as HTMLElement;
    const links = [...summary.querySelectorAll<HTMLAnchorElement>("a[href]")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["#check__review-landlord"]);
    // Focus went to the summary after the refusal.
    expect(summary.contains(m.root.activeElement)).toBe(true);
    const landlord = rowOf(m.root, "landlord");
    expect(landlord.classList.contains("datum-form__review-row--error")).toBe(true);
    expect(text(landlord.querySelector(".datum-form__review-error"))).not.toBe("");
    // The row's link says why it is in error: the summary moves focus onto it.
    expect(linkIn(landlord).getAttribute("aria-describedby")).toBe("check__review-landlord__error");
    expect(m.root.getElementById("check__review-landlord__error")?.classList.contains("datum-form__review-error")).toBe(true);
    expect(linkIn(rowOf(m.root, "main")).hasAttribute("aria-describedby")).toBe(false);
    links[0]!.click();
    expect(m.root.activeElement).toBe(linkIn(landlord));
    // The missing answer's link goes to its step with direction change.
    linkIn(landlord).click();
    await settled(m.form);
    expect(m.runtime.journeyView()).toMatchObject({ pageId: "landlord", returning: { reviewPageId: "check" } });
  });
});

describe("a Check answers page: a binding's review hook", () => {
  it("hands the binding the list's state with Datum's drawing as content, and falls back to Datum's when it throws", async () => {
    quiet();
    const seen: ReviewState[] = [];
    const custom = createDatumBinding();
    const binding = {
      ...custom,
      id: "ds",
      review: (state: ReviewState) => {
        seen.push(state);
        return lit.html`<div class="ds-review">${state.sections.map((section) => lit.html`<h2>${section.title}</h2>${section.items.map((item) =>
          item.kind === "row" ? lit.html`<p id=${item.id}>${item.label}: ${item.value}${item.change ? lit.html`<a href=${item.change.href} @click=${(e: Event) => (e.preventDefault(), item.change?.go())}>${item.change.text}</a>` : lit.nothing}</p>` : lit.nothing
        )}`)}</div>`;
      }
    };
    const m = await onCheck(runtimeOf(homeDefinition()), binding);
    const state = seen[seen.length - 1]!;
    expect(state).toMatchObject({ journeyId: "repair", pageId: "check", headingLevel: 2 });
    expect(state.content).toBeDefined();
    const main = state.sections[0]!.items[0]!;
    expect(main).toMatchObject({ kind: "row", id: "check__review-main", componentId: "main", label: "Is this your main home?", value: "Yes", status: "answered", errorId: "check__review-main__error" });
    expect(main.kind === "row" && main.change).toMatchObject({ pageId: "home", text: "Change", hidden: " Is this your main home?", href: "#home__page-heading" });
    expect(m.root.querySelector(".ds-review")).not.toBeNull();
    expect(m.root.querySelector("[data-journey-review]")).toBeNull();
    (m.root.getElementById("check__review-main")?.querySelector("a") as HTMLAnchorElement).click();
    await settled(m.form);
    expect(m.runtime.journeyView()?.pageId).toBe("home");

    const broken = await onCheck(runtimeOf(homeDefinition()), {
      ...custom,
      id: "broken",
      review: () => {
        throw new Error("no list");
      }
    });
    expect(broken.root.querySelector("[data-journey-review]")).not.toBeNull();
    expect(broken.errors.map((error) => error.hook)).toContain("review");
  });

  it("lets a Datum part wrap Datum's drawing of the list", async () => {
    quiet();
    const binding = createDatumBinding({ parts: { journeyReview: (part) => lit.html`<section class="host-review">${part.default}</section>` } });
    const m = await onCheck(runtimeOf(homeDefinition()), binding);
    expect(m.root.querySelector(".host-review [data-journey-review]")).not.toBeNull();
  });
});

// The list is a Check answers kit handed to the page module (`<datum-form>` loads it from a chunk of
// its own): a page module with none draws the page's heading, its own content and its actions.
describe("a Check answers page with no Check answers kit", () => {
  it("draws the heading, the page's own content and Submit, with no list and no sheet", async () => {
    quiet();
    const runtime = runtimeOf(homeDefinition());
    await toCheck(runtime);
    const m = await mounted(homeDefinition(), { runtime, binding: createDatumBinding(), features: [...createDatumFeatures(), createJourneyPageFeature()] });
    await settled(m.form);
    expect(text(heading(m.root))).toBe("Step 5 of 5: Check your answers before sending your application");
    expect(review(m.root)).toBeNull();
    expect(m.root.querySelector('[data-component-id="declare"]')).not.toBeNull();
    expect(text(m.root.querySelector("[data-journey-continue]"))).toBe("Submit");
    expect([...m.root.querySelectorAll("style")].some((style) => (style.textContent ?? "").includes(".datum-form__review-list"))).toBe(false);
    expect(m.errors).toEqual([]);
  });
});
