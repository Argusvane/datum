import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import "../src/form.js";
import type {
  DatumDownloadDetail,
  DatumFormChangeDetail,
  DatumFormElement,
  DatumFormPageChangeDetail,
  DatumFormSubmitDetail
} from "../src/form.js";
import { presentationForm } from "@argusvane/datum-engine/tests/fixtures/presentation-form";
import {
  EagerJourneyEngine,
  EagerJourneyRenderKit,
  defaultJourneyRenderKit,
  defineDatumFormHostElement,
  sourceHash,
  setDefaultJourneyRenderKit,
  type DatumFormActionDetail,
  type DatumFormHostElement,
  type Expression,
  type FormDefinition,
  type Journey,
  type JourneyConfiguration,
  type JourneyRenderKit
} from "@argusvane/datum-engine";

import { createFormRuntime } from "../src/runtime-factory.js";
import { createDatumBinding } from "../../../engine/form-engine/render/live/renderer.js";
import { journeyTitleOf, until } from "./helpers.js";
import { box, control, describedBy, inSummary, inputOf, invalidIds, journeyContinue, journeySubmit, leave, summaryLinks, summaryOf, type } from "./live-dom.js";

/*
 * Journeys through <datum-form>: the page a journey shows, Continue, Back and the
 * final Submit, where focus goes on each move, which journey opens, `datum-page-change`, and
 * the draft saved on a page change.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const path = (name: string): Expression => ({ kind: "path", path: name });
const eq = (name: string, value: string): Expression => ({
  kind: "binary",
  operator: "eq",
  left: path(name),
  right: { kind: "literal", value }
});
const neq = (name: string, value: string): Expression => ({
  kind: "binary",
  operator: "neq",
  left: path(name),
  right: { kind: "literal", value }
});

const YES_NO = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" }
];

/**
 * about -> (not an adult: the exit page) | residence (resident) | overseas (not resident)
 * -> contact -> end. A second, one-page journey beside it.
 */
function applyJourney(overrides: Partial<Journey> = {}): Journey {
  return {
    id: "apply",
    name: "Apply",
    validation: { continue: "page" },
    pages: [
      {
        id: "about",
        title: "About you",
        components: ["adult", "resident"],
        routes: [{ when: eq("adult", "no"), to: "not-eligible" }, { when: neq("resident", "yes"), to: "overseas" }]
      },
      { id: "residence", title: "Where you live", components: ["province"], routes: [{ to: "contact" }] },
      { id: "overseas", title: "Where you live abroad", components: ["country"] },
      { id: "contact", title: "How to reach you", components: ["email"], routes: [{ to: "$end" }] },
      { id: "not-eligible", kind: "exit", title: "You cannot apply" }
    ],
    ...overrides
  };
}

function shortJourney(): Journey {
  return { id: "short", pages: [{ id: "everything", title: "Your answers", components: ["adult", "email"] }] };
}

function eligibility(journey: JourneyConfiguration = { journeys: [applyJourney(), shortJourney()] }): FormDefinition {
  return {
    id: "eligibility",
    version: "3.0.0",
    schemaVersion: "1",
    localization: {
      defaultLocale: "en",
      supportedLocales: [
        { code: "en", label: "English" },
        { code: "fr-CA", label: "Français" }
      ]
    },
    // A journey's name is a string in the form's language; its French wording is at its own address.
    translations: { "fr-CA": { journeys: { apply: { name: { text: "Demander", source: sourceHash("Apply") } } } } },
    root: {
      id: "root",
      type: "form",
      configuration: { title: "Permit application" },
      children: {
        content: [
          { id: "adult", type: "radio", configuration: { label: "Are you 18 or older?", required: true, options: YES_NO } },
          { id: "resident", type: "radio", configuration: { label: "Do you live in Canada?", required: true, options: YES_NO } },
          { id: "province", type: "text", configuration: { label: "Province", required: true } },
          { id: "country", type: "text", configuration: { label: "Country", required: true } },
          { id: "email", type: "text", configuration: { label: "Email", required: true } }
        ]
      }
    },
    journey
  };
}

function mount(setup?: (element: DatumFormElement) => void): DatumFormElement {
  const element = document.createElement("datum-form");
  setup?.(element);
  document.body.append(element);
  return element;
}

function form(element: DatumFormElement): ShadowRoot {
  return element.renderer!.shadowRoot!;
}

/** The page shown, once it has painted: its heading's text. */
function heading(element: DatumFormElement): string | undefined {
  return journeyTitleOf(element.renderer?.shadowRoot?.querySelector<HTMLElement>("[data-journey-heading]"));
}

async function onPage(element: DatumFormElement, title: string): Promise<ShadowRoot> {
  await until(() => heading(element) === title);
  return form(element);
}

function listen<T>(element: HTMLElement, type: string): T[] {
  const seen: T[] = [];
  element.addEventListener(type, (event) => seen.push((event as CustomEvent<T>).detail));
  return seen;
}

function pick(root: ShadowRoot, name: string, value: string): void {
  inputOf(root, name, "radio", value).click();
}

const headingFocused = (root: ShadowRoot): boolean => root.activeElement?.hasAttribute("data-journey-heading") === true;

/** Answers the first page for a resident adult and continues to "Where you live". */
async function pastAbout(element: DatumFormElement): Promise<ShadowRoot> {
  const root = await onPage(element, "About you");
  pick(root, "adult", "yes");
  pick(root, "resident", "yes");
  await until(() => element.values.resident === "yes");
  root.querySelector<HTMLElement>("[data-journey-continue]")!.click();
  return onPage(element, "Where you live");
}

describe("<datum-form> journeys: the page and its moves", () => {
  it("opens on the journey's first page; Continue holds a page with errors and focuses the first, then moves on and focuses the next heading", async () => {
    const element = mount((el) => {
      el.definition = eligibility();
    });
    const root = await onPage(element, "About you");
    // A journey with no progress setting counts its steps over the heading.
    expect(root.querySelector("[data-journey-heading] .datum-form__journey-progress")?.textContent).toMatch(/^Step 1 of \d+: $/);
    // One page: its questions, no Back on the first page, Continue and no Submit.
    expect(root.querySelector('[data-component-id="adult"]')).not.toBeNull();
    expect(root.querySelector('[data-component-id="province"]')).toBeNull();
    expect(root.querySelector("[data-journey-back]")).toBeNull();
    expect(journeySubmit(root)).toBeNull();

    root.querySelector<HTMLElement>("[data-journey-continue]")!.click();
    await until(() => invalidIds(root).length > 0);
    expect(heading(element)).toBe("About you");
    // Both of this page's questions are reported; nothing from the pages ahead.
    expect(element.errors.map((error) => error.componentId).sort()).toEqual(["adult", "resident"]);
    // Under the engine's own themes an invalid submit moves focus to the error summary.
    await until(() => inSummary(root));

    pick(root, "adult", "yes");
    pick(root, "resident", "yes");
    await until(() => element.values.resident === "yes");
    root.querySelector<HTMLElement>("[data-journey-continue]")!.click();
    await onPage(element, "Where you live");
    await until(() => headingFocused(root));
    expect(element.page).toBe("residence");
  });

  it("Back follows the path back a page, and a jump to a page already reached opens it, each with focus on the heading", async () => {
    const element = mount((el) => {
      el.definition = eligibility();
    });
    const root = await pastAbout(element);
    type(control(root, "province")!, "ON");
    await until(() => element.values.province === "ON");
    root.querySelector<HTMLElement>("[data-journey-continue]")!.click();
    await onPage(element, "How to reach you");

    root.querySelector<HTMLElement>("[data-journey-back]")!.click();
    await onPage(element, "Where you live");
    await until(() => headingFocused(root));
    // What was typed there is still there.
    expect(control(root, "province")!.value).toBe("ON");

    expect((await element.goToPage("about")).ok).toBe(true);
    await onPage(element, "About you");
    await until(() => headingFocused(root));
    // A page not reached yet is refused, and the page stays.
    const refused = await element.goToPage("not-eligible");
    expect(refused).toMatchObject({ ok: false, reason: "unreachable" });
    expect(element.page).toBe("about");
    expect((await element.nextPage()).pageId).toBe("residence");
    expect((await element.previousPage()).pageId).toBe("about");
  });

  it("with actionOrder nextFirst Back stands after Continue in the page's actions, and Back and focus on the heading still work", async () => {
    const element = mount((el) => {
      el.binding = createDatumBinding({ controls: { actionOrder: "nextFirst" } });
      el.definition = eligibility();
    });
    const root = await pastAbout(element);
    const buttons = Array.from(root.querySelectorAll<HTMLElement>("[data-journey-continue], [data-journey-back]")).map((button) => (button.hasAttribute("data-journey-back") ? "back" : "continue"));
    expect(buttons).toEqual(["continue", "back"]);
    root.querySelector<HTMLElement>("[data-journey-back]")!.click();
    await onPage(element, "About you");
    await until(() => headingFocused(root));
  });

  it("keeps focus on the heading through a repaint, and leaves focus alone when a journey starts", async () => {
    const element = mount((el) => {
      el.definition = eligibility();
    });
    const root = await pastAbout(element);
    await until(() => headingFocused(root));
    // A value written while the heading has focus repaints the page; focus stays put.
    element.runtime!.setValue("email", "ada@example.com");
    await until(() => element.values.email === "ada@example.com");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(headingFocused(root)).toBe(true);

    // Starting a journey over the running form moves nothing: the person asked for no page.
    (root.activeElement as HTMLElement).blur();
    element.journey = "short";
    await onPage(element, "Your answers");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(root.activeElement).toBeNull();
  });

  it("the final Submit submits through the element, without the answers the path left behind", async () => {
    const element = mount((el) => {
      el.definition = eligibility();
    });
    const submits = listen<DatumFormSubmitDetail>(element, "datum-submit");
    const rawActions = listen<DatumFormActionDetail>(element, "datum-form-action");
    let root = await onPage(element, "About you");
    // Abroad first: the overseas page takes a country...
    pick(root, "adult", "yes");
    pick(root, "resident", "no");
    await until(() => element.values.resident === "no");
    root.querySelector<HTMLElement>("[data-journey-continue]")!.click();
    root = await onPage(element, "Where you live abroad");
    type(control(root, "country")!, "France");
    await until(() => element.values.country === "France");
    // ...then back, and resident after all: the country is off the path now.
    await element.goToPage("about");
    root = await onPage(element, "About you");
    pick(root, "resident", "yes");
    await until(() => element.values.resident === "yes");
    element.runtime!.setValue("province", "QC");
    element.runtime!.setValue("email", "ada@example.com");
    expect((await element.nextPage()).pageId).toBe("residence");
    expect((await element.nextPage()).pageId).toBe("contact");
    root = await onPage(element, "How to reach you");
    // The last page: Submit, no Continue.
    expect(journeyContinue(root)).toBeNull();
    journeySubmit(root)!.click();
    await until(() => submits.length === 1);

    expect(submits[0]!.accepted).toBe(true);
    const submission = submits[0]!.submission!;
    expect(submission.submission.values).toEqual({ adult: "yes", resident: "yes", province: "QC", email: "ada@example.com" });
    expect(submission.submission.journey).toEqual({ id: "apply" });
    // The answer is kept for the person, just not sent.
    expect(element.values.country).toBe("France");
    // The element acted on the journey's Submit itself; the raw engine event did not leak out.
    expect(rawActions).toEqual([]);
  });

  it("the journey's Submit triggers as no button, and a submit button on the last page stands in for it", async () => {
    const definition = eligibility();
    definition.root.children!.content!.push({ id: "send", type: "button", configuration: { label: "Send", action: "submit" } });
    const withButton = eligibility({
      journeys: [applyJourney({ pages: applyJourney().pages.map((page) => (page.id === "contact" ? { ...page, components: ["email", "send"] } : page)) })]
    });
    withButton.root = definition.root;

    const plain = mount((el) => {
      el.definition = eligibility();
    });
    await onPage(plain, "About you");
    const plainSubmit = vi.spyOn(plain.runtime!, "submit");
    plain.runtime!.setValue("adult", "yes");
    plain.runtime!.setValue("resident", "yes");
    plain.runtime!.setValue("province", "ON");
    plain.runtime!.setValue("email", "ada@example.com");
    await plain.nextPage();
    await plain.nextPage();
    const plainRoot = await onPage(plain, "How to reach you");
    journeySubmit(plainRoot)!.click();
    await until(() => plainSubmit.mock.calls.length === 1);
    expect(plainSubmit.mock.calls[0]![2]).not.toHaveProperty("trigger");

    const own = mount((el) => {
      el.definition = withButton;
    });
    await onPage(own, "About you");
    const ownSubmit = vi.spyOn(own.runtime!, "submit");
    own.runtime!.setValue("adult", "yes");
    own.runtime!.setValue("resident", "yes");
    own.runtime!.setValue("province", "ON");
    own.runtime!.setValue("email", "ada@example.com");
    await own.nextPage();
    await own.nextPage();
    const ownRoot = await onPage(own, "How to reach you");
    // The form's own button, with its wording and signing, in place of the journey's Submit.
    expect(journeySubmit(ownRoot)).toBeNull();
    ownRoot.querySelector<HTMLElement>('[data-button-action="submit"]')!.click();
    await until(() => ownSubmit.mock.calls.length === 1);
    expect(ownSubmit.mock.calls[0]![2]).toMatchObject({ trigger: { componentId: "send" } });
  });

  it("a blocked submit takes the person to the page holding the error, with focus on it", async () => {
    const element = mount((el) => {
      el.definition = eligibility();
    });
    const changes = listen<DatumFormPageChangeDetail>(element, "datum-page-change");
    const root = await pastAbout(element);
    element.runtime!.setValue("province", "ON");
    element.runtime!.setValue("email", "ada@example.com");
    await element.nextPage();
    await onPage(element, "How to reach you");
    // The service turned down the province: the form goes back to the page asking it.
    element.setErrors([{ componentId: "province", code: "province.closed", message: "Applications from this province are closed." }]);
    await onPage(element, "Where you live");
    await until(() => inSummary(root));
    expect(changes.at(-1)).toMatchObject({ pageId: "residence", fromPageId: "contact", direction: "error", errorCount: 1 });
  });
});

describe("<datum-form> journeys: Enter on a last page with a button of its own", () => {
  /** The last page asks two text questions and brings a download button, then a submit one, of its own. */
  function withOwnButtons(): FormDefinition {
    const definition = eligibility({
      journeys: [
        applyJourney({
          pages: applyJourney().pages.map((page) => (page.id === "contact" ? { ...page, components: ["save", "email", "phone", "send"] } : page))
        })
      ]
    });
    definition.root.children!.content!.push(
      { id: "phone", type: "text", configuration: { label: "Phone" } },
      { id: "save", type: "button", configuration: { label: "Save a copy", action: "download" } },
      { id: "send", type: "button", configuration: { label: "Send", action: "submit" } }
    );
    return definition;
  }

  function enter(target: HTMLElement): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  it("presses the page's submit button, not its download one, and settles the value typed first", async () => {
    const element = mount((el) => {
      el.definition = withOwnButtons();
    });
    await onPage(element, "About you");
    const submit = vi.spyOn(element.runtime!, "submit");
    const downloads = listen<DatumDownloadDetail>(element, "datum-download");
    const changes = listen<{ path: string }>(element, "datum-change");
    // An inner page draws Continue as a submit button: Enter there is the browser's to submit.
    const about = form(element);
    expect(enter(control(about, "adult")).defaultPrevented).toBe(false);

    element.runtime!.setValue("adult", "yes");
    element.runtime!.setValue("resident", "yes");
    element.runtime!.setValue("province", "ON");
    await element.nextPage();
    await element.nextPage();
    const root = await onPage(element, "How to reach you");
    // No submit button on the page: with two text fields, the browser's Enter would do nothing.
    expect(root.querySelector('button[type="submit"]')).toBeNull();
    const email = control(root, "email")!;
    email.focus();
    type(email, "ada@example.com");
    const pressed = enter(email);
    expect(pressed.defaultPrevented).toBe(true);
    // Settled at once, as Enter's own `change` would have: reported before the submit.
    expect(changes.some((change) => change.path === "email")).toBe(true);
    await until(() => submit.mock.calls.length === 1);
    expect(submit.mock.calls[0]![2]).toMatchObject({ trigger: { componentId: "send" } });
    expect(downloads).toEqual([]);
  });

  it("leaves Enter alone with a modifier, and in a field of an inner page", async () => {
    const element = mount((el) => {
      el.definition = withOwnButtons();
    });
    await onPage(element, "About you");
    element.runtime!.setValue("adult", "yes");
    element.runtime!.setValue("resident", "yes");
    element.runtime!.setValue("province", "ON");
    await element.nextPage();
    await element.nextPage();
    const root = await onPage(element, "How to reach you");
    const submit = vi.spyOn(element.runtime!, "submit");
    const shifted = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, composed: true, cancelable: true });
    control(root, "phone")!.dispatchEvent(shifted);
    expect(shifted.defaultPrevented).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("<datum-form> journeys: focus on the page's own controls", () => {
  const onControl = (root: ShadowRoot, seam: string): boolean => root.activeElement?.hasAttribute(seam) === true;

  it("keeps focus on Continue through a repaint, and on a Continue a hook refused", async () => {
    const element = mount((el) => {
      el.definition = eligibility();
      el.plugins = [
        {
          id: "gate",
          version: "1.0.0",
          hooks: {
            beforePageChange: [
              ({ toPageId }) => {
                if (toPageId === "contact") {
                  throw new Error("Not yet");
                }
              }
            ]
          }
        }
      ];
    });
    const root = await pastAbout(element);
    root.querySelector<HTMLElement>("[data-journey-continue]")!.focus();
    // A value the page writes repaints the page: focus stays on Continue.
    element.runtime!.setValue("province", "ON");
    await until(() => element.values.province === "ON");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onControl(root, "data-journey-continue")).toBe(true);

    // The hook refuses the move: the page stays, and so does the focus.
    root.querySelector<HTMLElement>("[data-journey-continue]")!.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(element.page).toBe("residence");
    expect(onControl(root, "data-journey-continue")).toBe(true);
  });

  it("puts focus back on the journey's Submit once a delivery the page held the form for is done", async () => {
    const element = mount((el) => {
      el.definition = eligibility();
    });
    await onPage(element, "About you");
    element.runtime!.setValue("adult", "yes");
    element.runtime!.setValue("resident", "yes");
    element.runtime!.setValue("province", "ON");
    element.runtime!.setValue("email", "ada@example.com");
    await element.nextPage();
    await element.nextPage();
    const root = await onPage(element, "How to reach you");
    let deliver!: () => void;
    const delivery = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    element.addEventListener("datum-submit", (event) => (event as CustomEvent<DatumFormSubmitDetail>).detail.waitUntil(delivery));
    const submitButton = journeySubmit(root)!;
    submitButton.focus();
    submitButton.click();
    await until(() => element.submitting);
    deliver();
    await until(() => !element.submitting);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(root.activeElement).toBe(journeySubmit(root));
  });

  it("moves focus from Back to the heading when the page Back led to has none", async () => {
    const element = mount((el) => {
      el.definition = eligibility();
    });
    const root = await pastAbout(element);
    const back = root.querySelector<HTMLElement>("[data-journey-back]")!;
    back.focus();
    back.click();
    await onPage(element, "About you");
    await until(() => headingFocused(root));
    expect(root.querySelector("[data-journey-back]")).toBeNull();
  });

  it("moves focus to the page's form on Continue, Back and a jump when the journey hides its heading, and keeps it there through a repaint", async () => {
    const element = mount((el) => {
      el.definition = eligibility({ journeys: [applyJourney({ heading: "hidden" })] });
    });
    const pageFocused = (root: ShadowRoot): boolean => root.activeElement?.hasAttribute("data-journey-page-focus") === true;
    await until(() => element.page === "about" && element.renderer?.shadowRoot?.querySelector("[data-journey-page-focus]"));
    const root = form(element);
    // No page heading, and no caption: the page is drawn as the whole form is, and its form takes focus.
    expect(root.querySelector("[data-journey-heading]")).toBeNull();
    expect(root.querySelector("h2, h3")).toBeNull();
    const pageForm = root.querySelector<HTMLElement>("form[data-journey-page-focus]")!;
    expect(pageForm.getAttribute("tabindex")).toBe("-1");
    expect(pageForm.hasAttribute("aria-labelledby")).toBe(false);

    pick(root, "adult", "yes");
    pick(root, "resident", "yes");
    await until(() => element.values.resident === "yes");
    root.querySelector<HTMLElement>("[data-journey-continue]")!.click();
    await until(() => element.page === "residence" && pageFocused(root));

    // A value written while the page has focus repaints it; focus stays put.
    element.runtime!.setValue("email", "ada@example.com");
    await until(() => element.values.email === "ada@example.com");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(pageFocused(root)).toBe(true);

    // Back from Back: the first page draws no Back, so focus lands on the page's form.
    const back = root.querySelector<HTMLElement>("[data-journey-back]")!;
    back.focus();
    back.click();
    await until(() => element.page === "about" && pageFocused(root));
    expect(root.querySelector("[data-journey-back]")).toBeNull();

    // A jump to a page already reached.
    expect((await element.nextPage()).pageId).toBe("residence");
    expect((await element.goToPage("about")).ok).toBe(true);
    await until(() => element.page === "about" && pageFocused(root));
  });
});

describe("<datum-form> journeys: datum-page-change", () => {
  it("reports each move: where from and to, how, where the page sits, its heading and its errors", async () => {
    const element = mount((el) => {
      el.definition = eligibility();
    });
    const changes = listen<DatumFormPageChangeDetail>(element, "datum-page-change");
    const root = await pastAbout(element);
    expect(changes).toEqual([
      {
        journeyId: "apply",
        pageId: "residence",
        fromPageId: "about",
        direction: "forward",
        index: 1,
        total: 3,
        title: "Where you live",
        kind: "questions",
        errorCount: 0
      }
    ]);
    root.querySelector<HTMLElement>("[data-journey-back]")!.click();
    await onPage(element, "About you");
    expect(changes[1]).toMatchObject({ pageId: "about", fromPageId: "residence", direction: "back", index: 0 });

    // The exit page, in the form's locale.
    element.setLocale("fr-CA");
    element.runtime!.setValue("adult", "no");
    await element.nextPage();
    expect(changes[2]).toMatchObject({ pageId: "not-eligible", direction: "forward", kind: "exit", title: "You cannot apply", total: 2 });
    // It bubbles out of the element and across shadow roots, like the element's other events.
    const outside: DatumFormPageChangeDetail[] = [];
    document.body.addEventListener("datum-page-change", (event) => outside.push((event as CustomEvent<DatumFormPageChangeDetail>).detail));
    await element.previousPage();
    expect(outside).toHaveLength(1);
  });
});

describe("<datum-form> journeys: a Check answers page", () => {
  const reviewing = (): Journey => ({
    id: "apply",
    name: "Apply",
    progress: "count",
    pages: [
      { id: "about", title: "About you", components: ["adult", "resident"] },
      { id: "contact", title: "How to reach you", components: ["email"] },
      { id: "check", kind: "review", title: "Check your answers" }
    ]
  });

  it("lists the answers with Submit; a Change link reports direction change with the page it returns to, and Continue comes back", async () => {
    const element = mount((el) => {
      el.definition = eligibility({ journeys: [reviewing()] });
    });
    await until(() => heading(element) !== undefined);
    const changes = listen<DatumFormPageChangeDetail>(element, "datum-page-change");
    element.runtime!.setValue("adult", "yes");
    element.runtime!.setValue("resident", "yes");
    await element.nextPage();
    element.runtime!.setValue("email", "ada@example.org");
    await element.nextPage();
    const root = await onPage(element, "Check your answers");
    expect(root.querySelector("[data-journey-heading] .datum-form__journey-progress")?.textContent).toBe("Step 3 of 3: ");
    expect(changes[changes.length - 1]).toMatchObject({ pageId: "check", direction: "forward", kind: "review", index: 2, total: 3 });
    expect(changes[changes.length - 1]).not.toHaveProperty("returnPageId");
    expect(journeySubmit(root)).not.toBeNull();
    const row = root.getElementById("check__review-email")!;
    expect(row.querySelector("dd")?.textContent?.trim()).toBe("ada@example.org");
    row.querySelector<HTMLAnchorElement>("a[href]")!.click();
    await onPage(element, "How to reach you");
    expect(changes[changes.length - 1]).toMatchObject({ pageId: "contact", fromPageId: "check", direction: "change", returnPageId: "check", kind: "questions" });
    await until(() => headingFocused(root));
    root.querySelector<HTMLElement>("[data-journey-continue]")!.click();
    await onPage(element, "Check your answers");
    expect(changes[changes.length - 1]).toMatchObject({ pageId: "check", fromPageId: "contact", direction: "forward", kind: "review" });
    expect(changes[changes.length - 1]).not.toHaveProperty("returnPageId");
    await until(() => root.activeElement === root.getElementById("check__review-email")?.querySelector("a[href]"));
  });
});

describe("<datum-form> journeys: which journey opens", () => {
  it("follows the definition when the page says nothing: its default journey, or the whole form when it opens as one", async () => {
    const byDefault = mount((el) => {
      el.definition = eligibility({ journeys: [applyJourney(), shortJourney()], defaultJourneyId: "short" });
    });
    await onPage(byDefault, "Your answers");
    expect(byDefault.page).toBe("everything");

    const asForm = mount((el) => {
      el.definition = eligibility({ journeys: [applyJourney(), shortJourney()], opensAs: "form" });
    });
    await until(() => control(asForm.renderer?.shadowRoot!, "email"));
    expect(heading(asForm)).toBeUndefined();
    expect(asForm.page).toBeUndefined();
    // Every question of the form, on one page.
    expect(control(form(asForm), "province")).not.toBeNull();
    // Every journey by its name, one page or many.
    expect(asForm.journeys()).toEqual([
      { id: "apply", label: "Apply" },
      { id: "short", label: "short" }
    ]);
  });

  it('takes a journey id, "form" and "journey" from the page, and warns about an id the form does not have', async () => {
    const byId = mount((el) => {
      el.setAttribute("journey", "short");
      el.definition = eligibility();
    });
    await onPage(byId, "Your answers");

    const whole = mount((el) => {
      el.setAttribute("journey", "form");
      el.definition = eligibility();
    });
    await until(() => control(whole.renderer?.shadowRoot!, "email"));
    expect(heading(whole)).toBeUndefined();

    const forced = mount((el) => {
      el.setAttribute("journey", "journey");
      el.definition = eligibility({ journeys: [applyJourney(), shortJourney()], opensAs: "form" });
    });
    await onPage(forced, "About you");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unknown = mount((el) => {
      el.setAttribute("journey", "renew");
      el.definition = eligibility();
    });
    await onPage(unknown, "About you");
    expect(warn.mock.calls.some((call) => String(call[0]).includes('no journey "renew"'))).toBe(true);
  });

  it("switches journey on the running form without a rebuild: the answers stay, the new journey starts on its first page", async () => {
    const element = mount((el) => {
      el.definition = eligibility();
    });
    const root = await pastAbout(element);
    const runtime = element.runtime;
    type(control(root, "province")!, "NS");
    await until(() => element.values.province === "NS");

    element.setAttribute("journey", "form");
    await until(() => heading(element) === undefined && control(form(element), "country"));
    expect(control(form(element), "province")!.value).toBe("NS");

    element.setAttribute("journey", "apply");
    await onPage(element, "About you");
    expect(element.runtime).toBe(runtime);
    expect(element.values).toMatchObject({ adult: "yes", resident: "yes", province: "NS" });

    // The journey already running is left where it is.
    await element.nextPage();
    await onPage(element, "Where you live");
    element.journey = "apply";
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(element.page).toBe("residence");

    // An unknown id, set on the running form, warns and falls back to the definition's choice.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    element.journey = "short";
    await onPage(element, "Your answers");
    element.journey = "renew";
    await onPage(element, "About you");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('no journey "renew"');
  });

  it("opens on `page` only when the person may reach it, and takes a running journey to a page already reached", async () => {
    // Nothing has been answered: only the first page may be reached.
    const element = mount((el) => {
      el.setAttribute("page", "contact");
      el.definition = eligibility();
    });
    await onPage(element, "About you");
    expect(element.page).toBe("about");

    element.runtime!.setValue("adult", "yes");
    element.runtime!.setValue("resident", "yes");
    element.runtime!.setValue("province", "ON");
    await element.nextPage();
    await element.nextPage();
    await onPage(element, "How to reach you");
    element.setAttribute("page", "about");
    await onPage(element, "About you");
    element.setAttribute("page", "contact");
    await onPage(element, "How to reach you");
    // The journey named again with a page: the journey runs already, so the page is a jump.
    element.journey = "apply";
    element.page = "residence";
    await onPage(element, "Where you live");
  });
});

it("says so, politely, when `page` names a page the answers cannot reach, and reports a redirect", async () => {
  const element = document.createElement("datum-form") as DatumFormElement;
  const changes: DatumFormPageChangeDetail[] = [];
  element.addEventListener("datum-page-change", (event) => changes.push((event as CustomEvent<DatumFormPageChangeDetail>).detail));
  element.setAttribute("page", "contact");
  element.definition = eligibility();
  document.body.append(element);
  await onPage(element, "About you");
  expect(element.page).toBe("about");
  const line = (): HTMLElement | null =>
    [...element.renderer!.shadowRoot!.querySelectorAll<HTMLElement>('[role="status"]')].find((region) => /not available yet/.test(region.textContent ?? "")) ?? null;
  expect(line()?.getAttribute("role")).toBe("status");
  expect(line()?.textContent).toMatch(/not available yet/);
  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({ pageId: "about", direction: "redirect", fromPageId: null });
  // The next navigation clears the line.
  element.runtime!.setValue("adult", "yes");
  element.runtime!.setValue("resident", "yes");
  element.runtime!.setValue("province", "ON");
  await element.nextPage();
  await onPage(element, "Where you live");
  expect(line()).toBeNull();
  // A running journey refused a jump says so too.
  element.setAttribute("page", "contact");
  await until(() => line());
  expect(changes.at(-1)).toMatchObject({ direction: "redirect" });
});

describe("<datum-form> journeys: a journey that reads what the page seeds", () => {
  /**
   * An agent's page, whose one question shows only when the host says the person is an agent
   * (`role`, on no page). No page is passed over: for anyone else the page is shown with nothing
   * on it. A page has no condition of its own; the first page has nothing before it to route from.
   */
  function seeded(contactWhen?: Expression): FormDefinition {
    return {
      id: "agent-form",
      version: "1.0.0",
      schemaVersion: "1",
      root: {
        id: "root",
        type: "form",
        configuration: {},
        children: {
          content: [
            { id: "role", type: "text", configuration: { label: "Role" } },
            { id: "agentNumber", type: "text", configuration: { label: "Agent number", required: true }, rules: { visibleWhen: eq("role", "agent") } },
            { id: "email", type: "text", configuration: { label: "Email", required: true }, ...(contactWhen ? { rules: { visibleWhen: contactWhen } } : {}) }
          ]
        }
      },
      journey: {
        journeys: [
          {
            id: "apply",
            pages: [
              { id: "agent", title: "Agent", components: ["agentNumber"] },
              { id: "contact", title: "Contact", components: ["email"], routes: [{ to: "$end" }] }
            ]
          }
        ]
      }
    };
  }

  it("decides the first page over the prefill, not over an empty form", async () => {
    const element = mount((el) => {
      el.values = { role: "agent" };
      el.definition = seeded();
    });
    const root = await onPage(element, "Agent");
    expect(element.page).toBe("agent");
    expect(root.querySelector("[data-journey-back]")).toBeNull();
    // And `page` is reachable, or not, over the prefill too.
    const deepLinked = mount((el) => {
      el.values = { role: "agent" };
      el.setAttribute("page", "contact");
      el.definition = seeded();
    });
    await onPage(deepLinked, "Agent");
  });

  it("starts a journey every page of which reads the prefill, and opens on its first page before any values arrive", async () => {
    const element = mount((el) => {
      el.values = { role: "agent" };
      el.definition = seeded(eq("role", "agent"));
    });
    await onPage(element, "Agent");

    // No values yet: every question on every page hidden, and the journey still opens on its
    // first page, showing nothing; the values show its question.
    const later = mount((el) => {
      el.definition = seeded(eq("role", "agent"));
    });
    const drawn = await onPage(later, "Agent");
    expect(later.page).toBe("agent");
    expect(control(drawn, "agentNumber")).toBeNull();
    later.values = { role: "agent" };
    await until(() => control(later.renderer!.shadowRoot!, "agentNumber"));
    expect(later.page).toBe("agent");
  });
});

describe("<datum-form> journeys: drafts", () => {
  it("saves the draft on a page change and resumes on that page with no errors showing", async () => {
    const element = mount((el) => {
      el.setAttribute("draft", "journey-draft");
      el.definition = eligibility();
    });
    await onPage(element, "About you");
    await element.clearDraft();
    element.runtime!.setValue("adult", "yes");
    element.runtime!.setValue("resident", "yes");
    await element.nextPage();
    // Saved on the move itself, well inside the typing debounce (300 ms).
    let stored = false;
    for (let attempt = 0; attempt < 10 && !stored; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      stored = await element.hasDraft();
    }
    expect(stored).toBe(true);
    element.remove();

    const again = mount((el) => {
      el.setAttribute("draft", "journey-draft");
      el.definition = eligibility();
    });
    const root = await onPage(again, "About you");
    const changes = listen<DatumFormPageChangeDetail>(again, "datum-page-change");
    await again.restoreDraft();
    await onPage(again, "Where you live");
    expect(changes).toEqual([expect.objectContaining({ pageId: "residence", direction: "resume" })]);
    expect(again.errors).toEqual([]);
    expect(invalidIds(root)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(root.activeElement).toBeNull();
    await again.clearDraft();
  });
});

describe("<datum-form> journeys: debug", () => {
  it("logs what diagnoseJourneys finds, once per definition", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const definition = eligibility({
      journeys: [
        applyJourney({
          pages: [...applyJourney().pages, { id: "orphan", title: "Never reached", components: ["missing"] }]
        })
      ]
    });
    const element = mount((el) => {
      el.setAttribute("debug", "");
      el.definition = definition;
    });
    await onPage(element, "About you");
    // The diagnostics come in a chunk of their own, loaded by `debug`: logged once it is in.
    const logged = (): string[] => [...error.mock.calls, ...warn.mock.calls].map((call) => String(call[0]));
    await until(() => logged().some((line) => line.startsWith('[datum-form] journey "apply", page "orphan"') && line.includes("page.unknown-component")));
    const count = logged().length;
    // The same definition again: nothing new.
    element.values = { email: "x" };
    element.setAttribute("heading-level", "2");
    element.definition = definition;
    await until(() => element.runtime !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(error.mock.calls.length + warn.mock.calls.length).toBe(count);
  });

  it("offers the diagnostics to the page by a load, never as a function the bundle carries", async () => {
    const bundle = await import("../src/form.js");
    // A re-export would put the diagnostics in datum-form.js for every form (check-bundles guards the bundle).
    expect("diagnoseJourneys" in bundle).toBe(false);
    const diagnose = await bundle.loadJourneyDiagnostics();
    expect(await bundle.loadJourneyDiagnostics()).toBe(diagnose);
    const definition = eligibility({
      journeys: [applyJourney({ pages: [...applyJourney().pages, { id: "orphan", title: "Never reached", components: ["missing"] }] })]
    });
    expect(diagnose(definition).map((finding) => finding.code)).toContain("page.unknown-component");
  });
});

describe("<datum-form-host> journeys", () => {
  // A page that builds its runtimes itself names the engine that runs a journey, and the kit its
  // renderer draws pages with, as the builder bundle's and the demo app's entries do:
  // nothing registers them by being imported, and the host element draws with the page's default kit.
  let previousKit: JourneyRenderKit;
  beforeAll(() => {
    previousKit = defaultJourneyRenderKit();
    setDefaultJourneyRenderKit(EagerJourneyRenderKit);
  });
  afterAll(() => {
    setDefaultJourneyRenderKit(previousKit);
  });

  function engineRuntime(definition: FormDefinition) {
    return createFormRuntime(definition, { journeyEngine: EagerJourneyEngine });
  }

  it("the journey's Submit reaches the host page as a submit, like a submit button's, naming the journey", async () => {
    defineDatumFormHostElement();
    const host = document.createElement("datum-form-host") as DatumFormHostElement;
    document.body.append(host);
    const runtime = engineRuntime(eligibility());
    host.runtime = runtime;
    const actions = listen<DatumFormActionDetail>(document.body, "datum-form-action");
    runtime.setValue("adult", "yes");
    runtime.setValue("resident", "yes");
    runtime.setValue("province", "ON");
    runtime.setValue("email", "ada@example.com");
    await runtime.nextPage();
    await runtime.nextPage();
    const renderer = host.shadowRoot!.querySelector("datum-form-renderer")!;
    await until(() => journeySubmit(renderer.shadowRoot!));
    journeySubmit(renderer.shadowRoot!)!.click();
    await until(() => actions.length === 1);
    expect(actions[0]).toEqual({ componentId: "root", action: "submit", journey: { journeyId: "apply", pageId: "contact" } });
  });

  it("takes the host's journey choice, and keeps it for every runtime handed over after it", async () => {
    defineDatumFormHostElement();
    const host = document.createElement("datum-form-host") as DatumFormHostElement;
    host.setAttribute("journey", "form");
    document.body.append(host);
    const first = engineRuntime(eligibility());
    expect(first.journeyView()?.journeyId).toBe("apply");
    host.runtime = first;
    expect(first.journeyView()).toBeUndefined();

    host.journey = "short";
    expect(first.journeyView()?.journeyId).toBe("short");
    const second = engineRuntime(eligibility());
    host.runtime = second;
    expect(second.journeyView()?.journeyId).toBe("short");

    // An unknown id warns once, however many runtimes follow.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    host.journey = "renew";
    host.runtime = engineRuntime(eligibility());
    host.runtime = engineRuntime(eligibility());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(host.runtime?.journeyView?.()?.journeyId).toBe("apply");
  });
});

describe("<datum-form> journeys: the download", () => {
  it("a download on the last page submits and saves the file", async () => {
    const definition = eligibility({
      journeys: [applyJourney({ pages: applyJourney().pages.map((page) => (page.id === "contact" ? { ...page, components: ["email", "save"] } : page)) })]
    });
    definition.root.children!.content!.push({ id: "save", type: "button", configuration: { label: "Save a copy", action: "download" } });
    const element = mount((el) => {
      el.definition = definition;
    });
    await onPage(element, "About you");
    const downloads = listen<DatumDownloadDetail>(element, "datum-download");
    element.addEventListener("datum-download", (event) => event.preventDefault());
    element.runtime!.setValue("adult", "yes");
    element.runtime!.setValue("resident", "yes");
    element.runtime!.setValue("province", "ON");
    element.runtime!.setValue("email", "ada@example.com");
    await element.nextPage();
    await element.nextPage();
    const root = await onPage(element, "How to reach you");
    root.querySelector<HTMLElement>('[data-button-action="download"]')!.click();
    await until(() => downloads.length === 1);
    expect(downloads[0]!.submission).toMatchObject({ submission: { journey: { id: "apply" } } });
  });
});

describe("<datum-form> presentations: own fields, an alias and a worked-out value", () => {
  /** The fixture: journey `apply` (an alias on "Your details", `m1`…`m3` worked out into `annual_income` on "Your income"), variant `public`. */
  function mountPresentation(setup?: (element: DatumFormElement) => void): DatumFormElement {
    return mount((el) => {
      el.changeDebounce = 0;
      setup?.(el);
      el.definition = presentationForm();
    });
  }

  const valuePathOf = (root: ShadowRoot, id: string): string | undefined => box(root, id).dataset.valuePath;
  const noOwnKeys = (values: Record<string, unknown>): boolean => Object.keys(values).every((key) => !key.startsWith("@"));

  it("types into an alias and a page's own fields: the form field fills, the worked-out copy follows, the submit carries form values only", async () => {
    const element = mountPresentation();
    const changes = listen<DatumFormChangeDetail>(element, "datum-change");
    const submits = listen<DatumFormSubmitDetail>(element, "datum-submit");
    let root = await onPage(element, "Your details");
    expect(valuePathOf(root, "work_email")).toBe("email");
    type(control(root, "work_email"), "ada@example.org");
    await until(() => element.values.email === "ada@example.org");
    expect(changes.at(-1)).toMatchObject({ path: "email", value: "ada@example.org" });

    expect(await element.nextPage()).toMatchObject({ ok: true, pageId: "income" });
    root = await onPage(element, "Your income");
    expect(valuePathOf(root, "m1")).toBe("@apply.m1");
    type(control(root, "m1"), "1000");
    type(control(root, "m2"), "2500");
    await until(() => control(root, "income_total").value === "3500");
    const copy = control(root, "income_total");
    expect(copy.readOnly).toBe(true);
    expect(valuePathOf(root, "income_total")).toBe("annual_income");
    expect(describedBy(copy)).toBe("Worked out from your answers");

    // The form's values and the presentation's own, apart.
    expect(element.values).toMatchObject({ email: "ada@example.org", annual_income: 3500 });
    expect(noOwnKeys(element.values)).toBe(true);
    expect(element.presentationValues()).toEqual({ m1: 1000, m2: 2500 });
    expect(element.runtime!.state().values["@apply.m1"]).toBe(1000);

    // `datum-change`: never an own field's path or answer; the worked-out value it moved is reported as the form field's.
    expect(changes.every((change) => !String(change.path).startsWith("@") && noOwnKeys(change.values))).toBe(true);
    expect(changes.filter((change) => change.path === "annual_income").map((change) => change.value)).toEqual([1000, 3500]);
    expect(changes.at(-1)!.values).toMatchObject({ email: "ada@example.org", annual_income: 3500 });

    // Below the threshold the journey ends here: the page's Submit, with the form's answers alone.
    journeySubmit(root)!.click();
    await until(() => submits.length === 1);
    expect(submits[0]!.accepted).toBe(true);
    expect(submits[0]!.submission!.submission.values).toEqual({ email: "ada@example.org", annual_income: 3500 });
    expect(JSON.stringify(submits[0]!.result)).not.toContain("@apply");
  });

  it("puts the form field's Required under the alias standing for it, once, and the summary's link goes to the alias", async () => {
    const element = mountPresentation();
    const root = await onPage(element, "Your details");
    expect(await element.nextPage()).toMatchObject({ ok: false, reason: "validation" });
    await until(() => invalidIds(root).includes("work_email"));
    expect(invalidIds(root)).toEqual(["work_email"]);
    // The summary lists it once, and its link goes to the alias's control.
    expect(summaryLinks(root).map((link) => link.getAttribute("href"))).toEqual(["#work_email"]);
    await until(() => inSummary(root));
  });

  it("lists each presentation by name, and reads presentationValues() for the one running", async () => {
    const element = mountPresentation();
    await onPage(element, "Your details");
    expect(element.journeys()).toEqual([
      { id: "apply", label: "Apply" },
      { id: "public", label: "Public" }
    ]);
    expect(element.presentationValues()).toEqual({});

    element.journey = "public";
    const root = await onPage(element, "Tell us about you");
    // The one-page journey's own columns hold the form's own email and name, drawn as on the form.
    expect(valuePathOf(root, "email")).toBe("email");
    expect(control(root, "name")).not.toBeNull();
    expect(root.querySelector("[data-journey-back]")).toBeNull();
    expect(journeySubmit(root)).not.toBeNull();
    expect(element.presentationValues()).toEqual({});

    element.journey = "form";
    await until(() => element.runtime?.journeyView() === undefined);
    expect(element.presentationValues()).toEqual({});
    expect(element.journeys().map((journey) => journey.id)).toEqual(["apply", "public"]);
  });

  it("heads datum-page-change with the page's first own question when the page has no title", async () => {
    const untitled = presentationForm();
    delete untitled.journey!.journeys![0]!.pages[1]!.title;
    const element = mount((el) => {
      el.definition = untitled;
    });
    const moves = listen<DatumFormPageChangeDetail>(element, "datum-page-change");
    await onPage(element, "Your details");
    element.runtime!.setValue("email", "ada@example.org");
    expect(await element.nextPage()).toMatchObject({ ok: true, pageId: "income" });
    await until(() => moves.some((move) => move.pageId === "income"));
    expect(moves.find((move) => move.pageId === "income")).toMatchObject({ title: "Month 1", kind: "questions" });
  });

  it("keeps own answers in the draft and brings them back on resume", async () => {
    const element = mountPresentation((el) => el.setAttribute("draft", "presentation-draft"));
    let root = await onPage(element, "Your details");
    await element.clearDraft();
    type(control(root, "work_email"), "ada@example.org");
    await until(() => element.values.email === "ada@example.org");
    await element.nextPage();
    root = await onPage(element, "Your income");
    type(control(root, "m1"), "1200");
    type(control(root, "m3"), "800");
    await until(() => element.values.annual_income === 2000);
    await element.runtime!.saveDraft("presentation-draft");
    element.remove();

    const again = mountPresentation((el) => el.setAttribute("draft", "presentation-draft"));
    await onPage(again, "Your details");
    expect(again.presentationValues()).toEqual({});
    await again.restoreDraft();
    const resumed = await onPage(again, "Your income");
    expect(again.presentationValues()).toEqual({ m1: 1200, m3: 800 });
    await until(() => control(resumed, "m1").value === "1200" && control(resumed, "income_total").value === "2000");
    expect(again.values).toMatchObject({ email: "ada@example.org", annual_income: 2000 });
    expect(noOwnKeys(again.values)).toBe(true);
    await again.clearDraft();
  });
});

describe("<datum-form> presentations: what a worked-out value moves, and errors as they are drawn", () => {
  /**
   * The fixture's `apply` with more on "Your income": an alias `bonus` (fills the form's
   * `bonus_amount`), `m2` hidden while the form's `name` is "hide", and an own `nickname` that
   * feeds nothing; `annual_income` is worked out as sum(m1, m2, bonus).
   */
  function workedOutForm(): FormDefinition {
    const definition = presentationForm();
    definition.root.children!.content!.push({ id: "bonus_amount", type: "number", configuration: { label: "Bonus" } });
    definition.journey!.journeys![0]!.pages[1]!.components = [
      { id: "m1", type: "number", configuration: { label: "Month 1" } },
      { id: "m2", type: "number", configuration: { label: "Month 2" }, rules: { visibleWhen: neq("name", "hide") } },
      { id: "bonus", type: "number", configuration: { label: "Bonus", fills: "bonus_amount" } },
      { id: "nickname", type: "text", configuration: { label: "Nickname" } },
      {
        id: "income_total",
        type: "journey-value",
        configuration: { to: "annual_income", value: { kind: "call", name: "sum", args: [path("m1"), path("m2"), path("bonus")] }, label: "Annual income" }
      }
    ];
    return definition;
  }

  async function onIncome(setup?: (element: DatumFormElement) => void): Promise<{ element: DatumFormElement; changes: DatumFormChangeDetail[] }> {
    const element = mount((el) => {
      el.changeDebounce = 0;
      setup?.(el);
      el.definition = workedOutForm();
    });
    await onPage(element, "Your details");
    element.runtime!.setValue("email", "ada@example.org");
    expect(await element.nextPage()).toMatchObject({ ok: true, pageId: "income" });
    await onPage(element, "Your income");
    return { element, changes: listen<DatumFormChangeDetail>(element, "datum-change") };
  }

  const reported = (changes: DatumFormChangeDetail[]): unknown[] => changes.splice(0).map((change) => [change.path, change.value]);
  const valuePathOf = (root: ShadowRoot, id: string): string | undefined => box(root, id).dataset.valuePath;

  it("reports the worked-out value an own field, an alias or a form answer moves — once, as the form field — and nothing for an own field that feeds none", async () => {
    const { element, changes } = await onIncome();
    const runtime = element.runtime!;
    // An own field: its answer is never reported, the value it moves is.
    runtime.setValue("@apply.m1", 1000);
    expect(reported(changes)).toEqual([["annual_income", 1000]]);
    // A second source of the same value: one report of its new total.
    runtime.setValue("@apply.m2", 2000);
    expect(reported(changes)).toEqual([["annual_income", 3000]]);
    // An alias writes the form field it fills: that, then the value it moved.
    runtime.setValue("bonus_amount", 500);
    expect(reported(changes)).toEqual([
      ["bonus_amount", 500],
      ["annual_income", 3500]
    ]);
    // A form answer that hides a source: the answer, then the value worked out without it.
    runtime.setValue("name", "hide");
    expect(reported(changes)).toEqual([
      ["name", "hide"],
      ["annual_income", 1500]
    ]);
    runtime.setValue("name", "Ada");
    expect(reported(changes)).toEqual([
      ["name", "Ada"],
      ["annual_income", 3500]
    ]);
    // An own field that feeds nothing: no event at all.
    runtime.setValue("@apply.nickname", "Addy");
    expect(changes).toEqual([]);
    runtime.setValue("@apply.m1", 1000);
    expect(changes).toEqual([]);
    expect(element.values).toMatchObject({ annual_income: 3500, bonus_amount: 500, name: "Ada" });
  });

  it("holds a typed source's worked-out value with it until the field is left, for an own field and an alias alike", async () => {
    const { element, changes } = await onIncome((el) => el.setAttribute("change-on", "commit"));
    const root = form(element);
    type(control(root, "m1"), "1200");
    await until(() => element.values.annual_income === 1200);
    expect(changes).toEqual([]);
    leave(control(root, "m1"));
    expect(reported(changes)).toEqual([["annual_income", 1200]]);

    type(control(root, "bonus"), "300");
    await until(() => element.values.annual_income === 1500);
    expect(changes).toEqual([]);
    leave(control(root, "bonus"));
    expect(reported(changes)).toEqual([
      ["bonus_amount", 300],
      ["annual_income", 1500]
    ]);
    expect(changes.every((change) => !String(change.path).startsWith("@"))).toBe(true);
  });

  it("counts datum-page-change's errors as the page shows them: a form field's under its alias, once", async () => {
    const element = mount((el) => {
      el.definition = presentationForm();
    });
    const moves = listen<DatumFormPageChangeDetail>(element, "datum-page-change");
    await onPage(element, "Your details");
    const runtime = element.runtime!;
    runtime.setValue("email", "ada@example.org");
    expect(await element.nextPage()).toMatchObject({ ok: true, pageId: "income" });
    runtime.setValue("email", "");
    runtime.setValue("@apply.m1", 100);
    expect((await element.submit()).accepted).toBe(false);
    await until(() => moves.some((move) => move.direction === "error"));
    expect(runtime.errors().map((error) => `${error.componentId}:${error.code}`).sort()).toEqual(["email:required", "work_email:required"]);
    const root = await onPage(element, "Your details");
    await until(() => invalidIds(root).length > 0);
    const move = moves.find((entry) => entry.direction === "error")!;
    expect(move.errorCount).toBe(1);
    expect(summaryOf(root)!.querySelectorAll("li")).toHaveLength(move.errorCount);
    expect(invalidIds(root)).toHaveLength(move.errorCount);
  });

  it("shows an alias's error on its form field in a review, prints the path's form fields without errors, and no own field", async () => {
    const definition = presentationForm();
    const m1 = definition.journey!.journeys![0]!.pages[1]!.components![0] as { configuration: Record<string, unknown> };
    m1.configuration.required = true;
    const element = mount((el) => {
      el.definition = definition;
    });
    await onPage(element, "Your details");
    expect((await element.submit()).accepted).toBe(false);
    expect(element.runtime!.errors().map((error) => `${error.componentId}:${error.code}`).sort()).toEqual([
      "annual_income:required",
      "email:required",
      "m1:required",
      "work_email:required"
    ]);
    const deadLinks = (html: string): string[] =>
      ["m1", "work_email", "income_total"].filter((id) => html.includes(`"#${id}"`) || html.includes(`data-focus-error="${id}"`));

    element.mode = "readonly";
    const root = form(element);
    await until(() => root.querySelector('form[data-mode="readonly"]') !== null);
    // A review shows no summary; the errors stand on the form's own fields, and no own field or alias is drawn.
    expect(summaryOf(root)).toBeNull();
    expect(invalidIds(root)).toEqual(["email", "annual_income"]);
    expect(["m1", "work_email", "income_total"].filter((id) => box(root, id) !== null)).toEqual([]);

    const printed: string[] = [];
    element.addEventListener("datum-print", (event) => {
      event.preventDefault();
      printed.push((event as CustomEvent<{ html: string }>).detail.html);
    });
    await element.print();
    expect(printed).toHaveLength(1);
    // The printed copy carries the path's pages headed in order, each with the form
    // field its own nodes stand for: an alias prints the field it fills, a worked-out value the
    // field it works out. No own field prints, and no error does: paper is no place to fix one.
    const doc = new DOMParser().parseFromString(printed[0]!, "text/html");
    expect([...doc.querySelectorAll(".dp-section--page > .dp-heading")].map((heading) => heading.textContent)).toEqual(["Your details", "Your income"]);
    expect([...doc.querySelectorAll(".datum-print__field")].map((field) => field.getAttribute("data-component-id"))).toEqual(["email", "annual_income"]);
    expect(deadLinks(printed[0]!)).toEqual([]);
    expect(printed[0]).not.toMatch(/data-focus-error|aria-invalid|is required|Enter /);
  });
});
