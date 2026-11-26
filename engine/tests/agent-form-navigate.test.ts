import { afterEach, describe, expect, it, vi } from "vitest";

import type { FormDefinition } from "../form-engine/core/schema/types.js";
import { defineDataSources } from "../form-engine/data/host/data-source-set.js";
import { AGENT_JOURNEY_FORM, AGENT_SINGLE_FORM, AGENT_STEPS_FORM, PROVINCES, agentSetup, personTypes } from "./fixtures/agent-form.js";

/**
 * navigate and set_locale: the journey's moves through
 * the runtime's own `nextPage` / `previousPage` / `goToPage`, the steps container's Continue
 * sequence (`validate({ scope })`, `markStepCompleted`, `navigate`), reveal that never moves the
 * person, and the language switch.
 */

type Row = Record<string, unknown>;

/** The journey form with a server check on every page and a validator that never answers. */
function serverCheckedJourney(): FormDefinition {
  const journey = { ...(AGENT_JOURNEY_FORM.journey as unknown as { journeys: Array<Record<string, unknown>> }).journeys[0], validation: { continue: "page", server: true } };
  return { ...AGENT_JOURNEY_FORM, journey: { journeys: [journey] } } as unknown as FormDefinition;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("navigate on a journey", () => {
  it("is blocked by the page's checks with the errors worded, which are then shown to the person", async () => {
    const setup = agentSetup(AGENT_JOURNEY_FORM);
    const nextPage = vi.spyOn(setup.runtime, "nextPage");
    const result = await setup.refused("navigate", { to: "next" });
    expect(result).toMatchObject({
      code: "blocked",
      retryable: false,
      message: "The page 'Name' did not pass its checks, so the form stayed on it.",
      hint: "Fix the listed problems with set_answers, then call navigate again.",
      details: { reason: "validation" }
    });
    expect((result.details as Row).errors).toEqual([
      { path: "applicant_name", id: "applicant_name", label: "Name", code: "required", message: "This field is required", severity: "error", source: "client", page: "intro" }
    ]);
    expect(nextPage).toHaveBeenCalledTimes(1);
    expect(setup.runtime.errors().length).toBe(1);
    expect(setup.runtime.journeyView()?.pageId).toBe("intro");
  });

  it("moves next once the page passes, reporting from, page, pages and the shown page's outline; back needs no check", async () => {
    const setup = agentSetup(AGENT_JOURNEY_FORM);
    await setup.ok("set_answers", { answers: { applicant_name: "Ada" } });
    setup.host.calls.length = 0;
    const result = await setup.ok("navigate", { to: "next" });
    expect(result).toMatchObject({ moved: true, from: { id: "intro", title: "Name", number: 1, total: 3 }, page: { id: "contact", title: "How to reach you", number: 2, total: 3 }, final: false });
    expect((result.pages as Row[]).find((page) => page.id === "intro")).toMatchObject({ completed: true, current: false });
    expect((result.pages as Row[]).find((page) => page.id === "contact")).toMatchObject({ current: true, reachable: true });
    expect((result.fields as Row[]).map((field) => field.path)).toEqual(["contact_method", "email", "confirm_email", "province", "stop_code"]);
    expect((result.fields as Row[])[0]).not.toHaveProperty("value");
    expect(setup.host.calls.find((call) => call.method === "announce")?.args).toEqual(["An assistant moved to How to reach you"]);
    const same = await setup.ok("navigate", { to: "contact" });
    expect(same.moved).toBe(false);
    expect(same.from).toBeUndefined();
    const back = await setup.ok("navigate", { to: "back" });
    expect(back).toMatchObject({ moved: true, page: { id: "intro" } });
  });

  it("refuses at-end on the last page, exit-page after an exit route, at-start on the first, unreachable and unknown jumps", async () => {
    const setup = agentSetup(AGENT_JOURNEY_FORM);
    const start = await setup.refused("navigate", { to: "back" });
    expect(start).toMatchObject({ code: "at-start", hint: "There is no earlier page.", details: { page: "intro" } });
    const jump = await setup.refused("navigate", { to: "review" });
    expect(jump).toMatchObject({ code: "unreachable", hint: "Move with 'next' until intro; later pages open as earlier pages pass their checks.", details: { to: "review", frontier: "intro" } });
    const unknown = await setup.refused("navigate", { to: "nowhere" });
    expect(unknown).toMatchObject({ code: "unknown-page", hint: "Use 'next', 'back', or one of the listed page ids.", details: { to: "nowhere" } });
    expect(((unknown.details as Row).pages as Row[]).map((page) => page.id)).toEqual(["intro", "contact", "details", "review", "stop"]);

    await setup.ok("set_answers", { answers: { applicant_name: "Ada", contact_method: "email", email: "a@b.c", confirm_email: "a@b.c" } });
    await setup.ok("navigate", { to: "next" });
    const review = await setup.ok("navigate", { to: "next" });
    expect(review).toMatchObject({ moved: true, page: { id: "review" }, final: true });
    const end = await setup.refused("navigate", { to: "next" });
    expect(end).toMatchObject({ code: "at-end", hint: "This is the last page: call check {scope:'form'} and then submit.", details: { page: "review" } });
    const backToIntro = await setup.ok("navigate", { to: "intro" });
    expect(backToIntro).toMatchObject({ moved: true, page: { id: "intro" } });

    const exit = agentSetup(AGENT_JOURNEY_FORM);
    await exit.ok("set_answers", { answers: { applicant_name: "Ada", stop_code: "STOP" } });
    await exit.ok("navigate", { to: "next" });
    const stopped = await exit.ok("navigate", { to: "next" });
    expect(stopped).toMatchObject({ moved: true, page: { id: "stop", title: "Not eligible" } });
    const onExit = await exit.refused("navigate", { to: "next" });
    expect(onExit).toMatchObject({ code: "exit-page", hint: "The form has ended here; read the page's message to the person.", details: { page: "stop", title: "Not eligible" } });
    const submit = await exit.refused("submit");
    expect(submit).toMatchObject({ code: "exit-page" });
  });

  it("moves from a Check answers page as its Change link, and follows the runtime's Back on the way back", async () => {
    const reviewForm = {
      id: "review-agent",
      version: "1.0.0",
      schemaVersion: "1.0.0",
      localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }] },
      root: {
        id: "form",
        type: "form",
        configuration: { label: "Review" },
        children: {
          content: [
            { id: "applicant_name", type: "text", configuration: { label: "Name", required: true } },
            { id: "city", type: "text", configuration: { label: "City" } }
          ]
        }
      },
      journey: {
        journeys: [
          {
            id: "main",
            pages: [
              { id: "name", title: "Name", components: ["applicant_name"] },
              { id: "where", title: "Where", components: ["city"] },
              { id: "check", kind: "review", title: "Check your answers" }
            ]
          }
        ]
      }
    } as unknown as FormDefinition;
    const setup = agentSetup(reviewForm);
    await setup.ok("set_answers", { answers: { applicant_name: "Ada", city: "Ottawa" } });
    await setup.ok("navigate", { to: "next" });
    expect(await setup.ok("navigate", { to: "next" })).toMatchObject({ page: { id: "check" }, final: true });
    const goToPage = vi.spyOn(setup.runtime, "goToPage");
    expect(await setup.ok("navigate", { to: "name" })).toMatchObject({ moved: true, page: { id: "name" } });
    expect(goToPage).toHaveBeenCalledWith("name", { direction: "change" });
    expect(setup.runtime.journeyView()?.returning).toEqual({ reviewPageId: "check", nextPageId: "check" });
    // The first page, yet Back leads on to the review page, as the runtime's Back does.
    expect(await setup.ok("navigate", { to: "back" })).toMatchObject({ moved: true, page: { id: "check" } });
    await setup.ok("navigate", { to: "where" });
    expect(await setup.ok("navigate", { to: "next" })).toMatchObject({ moved: true, page: { id: "check" } });
    // Away from a review page a move to a page is a plain jump.
    await setup.ok("navigate", { to: "where" });
    goToPage.mockClear();
    await setup.ok("navigate", { to: "name" });
    expect(goToPage).toHaveBeenCalledWith("name", {});
  });

  it("times out at 20 s while a server check is out (stillRunning), and answers busy page-check meanwhile", async () => {
    vi.useFakeTimers();
    const setup = agentSetup(serverCheckedJourney(), { deps: { journeyServerValidator: () => new Promise(() => undefined), journeyServerValidationTimeoutMs: 60_000 } });
    await setup.ok("set_answers", { answers: { applicant_name: "Ada" } });
    const call = setup.refused("navigate", { to: "next" });
    await vi.advanceTimersByTimeAsync(20_100);
    const timeout = await call;
    expect(timeout).toMatchObject({ code: "timeout", retryable: true, hint: "The form is still working. Call describe_form to see where things stand.", details: { afterMs: 20_000, stillRunning: true } });
    const busy = await setup.refused("navigate", { to: "next" });
    expect(busy).toMatchObject({ code: "busy", details: { because: "page-check" } });
    const described = await setup.ok("describe_form");
    expect((described.status as Row).pending).toBe("page");
  });

  it("refuses feature-off when the definition declares journeys the page left out, and bad-input on a one-page form", async () => {
    const off = agentSetup(AGENT_JOURNEY_FORM, { journey: "form", host: { allows: { journeys: false } } });
    const refused = await off.refused("navigate", { to: "next" });
    expect(refused).toMatchObject({ code: "feature-off", details: { feature: "journeys" } });
    const single = agentSetup(AGENT_SINGLE_FORM);
    const bad = await single.refused("navigate", { to: "next" });
    expect(bad).toMatchObject({ code: "bad-input", details: { problems: [{ key: "to" }] } });
    const neither = await single.refused("navigate", {});
    expect(neither).toMatchObject({ code: "bad-input" });
  });
});

describe("navigate on steps", () => {
  it("next validates the step as Continue does, marks it completed and moves; back skips the check", async () => {
    const setup = agentSetup(AGENT_STEPS_FORM);
    const validate = vi.spyOn(setup.runtime, "validate");
    const blocked = await setup.refused("navigate", { to: "next" });
    expect(blocked).toMatchObject({ code: "blocked", details: { reason: "validation" } });
    expect(((blocked.details as Row).errors as Row[]).map((error) => error.path)).toEqual(["name"]);
    expect(validate).toHaveBeenCalledWith({ scope: "step1" });
    expect(setup.runtime.errors().length).toBe(1);
    await setup.ok("set_answers", { answers: { name: "Ada" } });
    const moved = await setup.ok("navigate", { to: "next" });
    expect(moved).toMatchObject({ moved: true, from: { id: "step1" }, page: { id: "step2", title: "Where", number: 2, total: 2 }, final: true });
    expect(setup.runtime.state().navigation.completedSteps.has("step1")).toBe(true);
    expect(setup.runtime.state().navigation.currentStepId).toBe("step2");
    expect((moved.pages as Row[]).map((page) => [page.id, page.completed, page.current])).toEqual([
      ["step1", true, false],
      ["step2", false, true]
    ]);
    expect((moved.fields as Row[]).map((field) => field.path)).toEqual(["intro_note", "step2", "city", "notes"]);
    const end = await setup.refused("navigate", { to: "next" });
    expect(end.code).toBe("at-end");
    validate.mockClear();
    const back = await setup.ok("navigate", { to: "back" });
    expect(back).toMatchObject({ moved: true, page: { id: "step1" } });
    expect(validate).not.toHaveBeenCalled();
    const start = await setup.refused("navigate", { to: "back" });
    expect(start.code).toBe("at-start");
    const byId = await setup.ok("navigate", { to: "step2" });
    expect(byId.moved).toBe(true);
  });

  it("refuses a jump to an upcoming step as unreachable, and an unknown step id", async () => {
    const setup = agentSetup(AGENT_STEPS_FORM);
    const upcoming = await setup.refused("navigate", { to: "step2" });
    expect(upcoming).toMatchObject({ code: "unreachable", details: { to: "step2", frontier: "step1" } });
    const unknown = await setup.refused("navigate", { to: "step9" });
    expect(unknown).toMatchObject({ code: "unknown-page" });
  });
});

describe("navigate reveal", () => {
  it("reveals a field on the current page through the host (opening its tab) and never focuses", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    const result = await setup.ok("navigate", { reveal: "tabbed" });
    expect(result).toMatchObject({ moved: false, revealed: { path: "tabbed", id: "tabbed", onCurrentPage: true, opened: { tab: "tab1" } } });
    expect(setup.host.calls.filter((call) => call.method !== "emit").map((call) => call.method)).toEqual(["reveal"]);
    expect(setup.host.calls[0]?.args).toEqual([["tabbed"]]);
    const unknown = await setup.refused("navigate", { reveal: "tabbd" });
    expect(unknown).toMatchObject({ code: "unknown-field" });
    expect(((unknown.details as Row).suggestions as string[])[0]).toBe("tabbed");
  });

  it("reports a field on another step or page with its step / page and does not call the host", async () => {
    const steps = agentSetup(AGENT_STEPS_FORM);
    const other = await steps.ok("navigate", { reveal: "city" });
    expect(other.revealed).toEqual({ path: "city", id: "city", onCurrentPage: false, step: "step2" });
    expect(steps.host.calls.some((call) => call.method === "reveal")).toBe(false);
    expect(steps.runtime.state().navigation.currentStepId).toBeUndefined();
    const journey = agentSetup(AGENT_JOURNEY_FORM);
    const later = await journey.ok("navigate", { reveal: "email" });
    expect(later.revealed).toEqual({ path: "email", id: "email", onCurrentPage: false, page: "contact" });
    expect(journey.host.calls.some((call) => call.method === "reveal")).toBe(false);
    expect(journey.runtime.journeyView()?.pageId).toBe("intro");
  });
});

describe("set_locale", () => {
  it("switches the language, clears the answer memo so sources are asked again, and announces", async () => {
    let loads = 0;
    // The announcement in French is the form's `texts` translation (the engine words only English).
    const fixture = AGENT_JOURNEY_FORM.translations ?? {};
    const worded: FormDefinition = {
      ...AGENT_JOURNEY_FORM,
      translations: {
        ...fixture,
        fr: { ...fixture.fr, texts: { ...fixture.fr?.texts, form: { agentLanguage: { text: "Un assistant a changé la langue du formulaire pour {{label}}", source: "x" } } } }
      }
    };
    const setup = agentSetup(worded, {
      dataSources: defineDataSources({
        provinces: () => {
          loads += 1;
          return PROVINCES;
        }
      })
    });
    await setup.ok("describe_form");
    expect(loads).toBe(1);
    const result = await setup.ok("set_locale", { locale: "fr" });
    expect(result).toMatchObject({ locale: "fr", previous: "en", locales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }], title: "Form tests fixture" });
    expect(setup.runtime.state().locale).toBe("fr");
    const described = await setup.ok("describe_form");
    expect((described.fields as Row[])[0]).toMatchObject({ path: "applicant_name", label: "Nom" });
    expect(loads).toBe(2);
    expect(setup.host.calls.find((call) => call.method === "setLocale")?.args).toEqual(["fr"]);
    expect(setup.host.calls.find((call) => call.method === "announce")?.args).toEqual(["Un assistant a changé la langue du formulaire pour Français"]);
    const same = await setup.ok("set_locale", { locale: "fr" });
    expect(same.note).toEqual(["Already in that language."]);
  });

  it("refuses feature-off, locale-unsupported with the list, and a malformed code as bad-input", async () => {
    const off = await agentSetup(AGENT_JOURNEY_FORM, { host: { allows: { translations: false } } }).refused("set_locale", { locale: "fr" });
    expect(off).toMatchObject({ code: "feature-off", details: { feature: "translations" } });
    const setup = agentSetup(AGENT_JOURNEY_FORM);
    const unsupported = await setup.refused("set_locale", { locale: "de" });
    expect(unsupported).toEqual(
      expect.objectContaining({
        code: "locale-unsupported",
        message: "This form is not available in 'de'.",
        hint: "Use one of the listed locale codes.",
        details: { locale: "de", supported: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] }
      })
    );
    const bad = await setup.refused("set_locale", { locale: "not a locale" });
    expect(bad).toMatchObject({ code: "bad-input", details: { problems: [{ key: "locale" }] } });
    expect(setup.runtime.state().locale).toBe("en");
  });
});

describe("navigate to the page already shown", () => {
  it("moves nothing and leaves the revision where it was", async () => {
    const setup = agentSetup(AGENT_JOURNEY_FORM);
    const before = (await setup.ok("describe_form")).revision as number;
    const result = await setup.ok("navigate", { to: "intro" });
    expect(result).toMatchObject({ moved: false, page: { id: "intro" } });
    expect(result.from).toBeUndefined();
    expect(result.revision).toBe(before);
    expect(setup.host.calls.filter((call) => call.method === "announce")).toEqual([]);
  });
});
