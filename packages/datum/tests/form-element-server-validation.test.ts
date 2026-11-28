import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/form.js";
import {
  JourneyValidationHttpError,
  createFetchJourneyValidator,
  type DatumFormElement,
  type DatumFormSubmitDetail,
  type JourneyValidationRequest,
  type JourneyValidationResponse
} from "../src/form.js";
import type { CanonicalSubmission, DatumDownloadDetail, FormDefinition, Journey } from "@argusvane/datum-engine";

import { EMBED_SUBMISSION_MODE, versionContextFor } from "../src/runtime-factory.js";
import { control } from "./live-dom.js";
import { journeyTitleOf, until } from "./helpers.js";

/*
 * A journey's checks with the page's service through <datum-form>: `validate-url`
 * posting each check as JSON, `serverValidator` beside it, what the person sees while a check
 * is out and when the service cannot be reached, and the download that skips the end check.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const eq = (name: string, value: string): string => `${name} = "${value}"`;

/** about -> residence (resident) | overseas (not resident; checked with the service) -> contact. */
function checkedJourney(overrides: Partial<Journey> = {}): Journey {
  return {
    id: "apply",
    pages: [
      {
        id: "about",
        title: "About you",
        components: ["resident"],
        routes: [{ when: eq("resident", "yes"), to: "residence" }, { when: eq("resident", "no"), to: "overseas" }, { to: "contact" }]
      },
      { id: "residence", title: "Where you live", components: ["province"], routes: [{ to: "contact" }] },
      { id: "overseas", title: "Where you live abroad", components: ["country"], validation: { continue: "page", server: true } },
      { id: "contact", title: "How to reach you", components: ["email"] }
    ],
    ...overrides
  };
}

function definition(journey: Journey = checkedJourney()): FormDefinition {
  return {
    id: "eligibility",
    version: "3.0.0",
    schemaVersion: "1",
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }] },
    root: {
      id: "root",
      type: "form",
      configuration: { title: "Permit application" },
      children: {
        content: [
          {
            id: "resident",
            type: "radio",
            configuration: {
              label: "Do you live in Canada?",
              required: true,
              options: [
                { value: "yes", label: "Yes" },
                { value: "no", label: "No" }
              ]
            }
          },
          { id: "province", type: "text", configuration: { label: "Province", required: true } },
          { id: "country", type: "text", configuration: { label: "Country", required: true } },
          { id: "email", type: "text", configuration: { label: "Email", required: true } }
        ]
      }
    },
    journey: { journeys: [journey] }
  };
}

function mount(setup?: (element: DatumFormElement) => void): DatumFormElement {
  const element = document.createElement("datum-form");
  setup?.(element);
  document.body.append(element);
  return element;
}

function heading(element: DatumFormElement): string | undefined {
  return journeyTitleOf(element.renderer?.shadowRoot?.querySelector<HTMLElement>("[data-journey-heading]"));
}

async function onPage(element: DatumFormElement, title: string): Promise<ShadowRoot> {
  await until(() => heading(element) === title);
  return element.renderer!.shadowRoot!;
}

/** Answers "not resident" and a country, and continues to the overseas page. */
async function atOverseas(element: DatumFormElement, country = "Atlantis"): Promise<ShadowRoot> {
  await onPage(element, "About you");
  element.runtime!.setValue("resident", "no");
  expect((await element.nextPage()).pageId).toBe("overseas");
  element.runtime!.setValue("country", country);
  return onPage(element, "Where you live abroad");
}

function continueOn(root: ShadowRoot): void {
  root.querySelector<HTMLElement>("[data-journey-continue]")!.click();
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function summaryText(root: ShadowRoot): string {
  return root.querySelector("[data-datum-summary]")?.textContent ?? "";
}

/** What the form's status regions say, one string each. */
function statusLines(root: ShadowRoot): string[] {
  return [...root.querySelectorAll('[role="status"]')].map((region) => region.textContent?.trim() ?? "");
}

describe("<datum-form> journey checks through validate-url", () => {
  it("posts the page's check as a Datum host's delivery and shows the errors the service reports, whether it names the field `field` or `componentId`", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(reply(200, { accepted: false, errors: [{ field: "country", code: "country.unknown", message: "We do not recognise that country." }] }))
      .mockResolvedValueOnce(reply(422, { errors: [{ componentId: "country", code: "country.closed", message: "Applications from there are closed." }] }))
      .mockResolvedValueOnce(reply(200, { accepted: true, errors: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const element = mount((el) => {
      el.setAttribute("validate-url", "/api/journey-check");
      el.definition = definition();
    });
    const root = await atOverseas(element);

    continueOn(root);
    await until(() => control(root, "country")?.getAttribute("aria-invalid") === "true");
    expect(heading(element)).toBe("Where you live abroad");
    expect(root.textContent).toContain("We do not recognise that country.");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    // The attribute keeps the absolute URL it was checked as.
    expect(url).toBe(new URL("/api/journey-check", document.baseURI).href);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    // The delivery `POST /api/submissions/validate` takes: the envelope Submit would emit, the scope and the page.
    const body = JSON.parse(String(init?.body)) as { document: CanonicalSubmission; scope: string; pageId?: string };
    expect(Object.keys(body).sort()).toEqual(["document", "pageId", "scope"]);
    expect(body).toMatchObject({ scope: "page", pageId: "overseas" });
    expect(Object.keys(body.document).sort()).toEqual(["submission", "versionContext"]);
    expect(body.document.versionContext.form).toEqual({ id: "eligibility", version: "3.0.0" });
    expect(body.document.versionContext.client).toMatchObject(versionContextFor(definition()).client);
    expect(body.document.submission).toMatchObject({ locale: "en", journey: { id: "apply" } });
    expect(body.document.submission.values).toMatchObject({ resident: "no", country: "Atlantis" });
    expect(body.document.submission.values).not.toHaveProperty("province");

    // A different answer, a different verdict (a 422 carries one too).
    element.runtime!.setValue("country", "Narnia");
    continueOn(root);
    await until(() => root.textContent?.includes("Applications from there are closed."));
    expect(heading(element)).toBe("Where you live abroad");

    element.runtime!.setValue("country", "France");
    continueOn(root);
    await onPage(element, "How to reach you");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("posts the journey's end check with scope journey and no page, over the envelope Submit then emits", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => reply(200, { accepted: true, errors: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const element = mount((el) => {
      el.setAttribute("validate-url", "/api/submissions/validate");
      el.definition = definition(checkedJourney({ validation: { end: "server" } }));
    });
    await onPage(element, "About you");
    element.runtime!.setValue("resident", "yes");
    element.runtime!.setValue("province", "ON");
    element.runtime!.setValue("email", "ada@example.com");
    await element.nextPage();
    await element.nextPage();
    await onPage(element, "How to reach you");
    const detail = await element.submit();
    expect(detail.accepted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as { document: CanonicalSubmission; scope: string };
    expect(Object.keys(body).sort()).toEqual(["document", "scope"]);
    expect(body.scope).toBe("journey");
    // The check judged exactly what is delivered.
    expect(body.document).toEqual(JSON.parse(JSON.stringify(detail.submission)));
  });

  it("shows the warnings a host lists under notes without blocking a second Continue", async () => {
    const fetchMock = vi.fn(async () =>
      reply(200, { accepted: true, errors: [], notes: [{ field: "country", code: "country.slow", severity: "warning", message: "Checks from there take longer." }] })
    );
    vi.stubGlobal("fetch", fetchMock);
    const element = mount((el) => {
      el.setAttribute("validate-url", "/api/journey-check");
      el.definition = definition();
    });
    const root = await atOverseas(element);
    continueOn(root);
    await until(() => root.textContent?.includes("Checks from there take longer."));
    expect(heading(element)).toBe("Where you live abroad");
    continueOn(root);
    await onPage(element, "How to reach you");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tells the person the answers could not be checked when the service fails, and keeps them on the page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(500, { message: "down" })));
    const element = mount((el) => {
      el.setAttribute("validate-url", "/api/journey-check");
      el.definition = definition();
    });
    const root = await atOverseas(element);
    continueOn(root);
    await until(() => summaryText(root).includes("We could not check your answers. Try again."));
    expect(heading(element)).toBe("Where you live abroad");
  });

  it("holds the page on a 4xx as on an outage: a lapsed session or a moved route is no verdict", async () => {
    for (const status of [401, 403, 404]) {
      const fetchMock = vi.fn(async () => reply(status, { message: "no" }));
      vi.stubGlobal("fetch", fetchMock);
      const element = mount((el) => {
        el.setAttribute("validate-url", "/api/journey-check");
        el.definition = definition();
      });
      const root = await atOverseas(element);
      continueOn(root);
      await until(() => summaryText(root).includes("We could not check your answers. Try again."));
      expect(heading(element)).toBe("Where you live abroad");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      element.remove();
    }
  });

  it("gives up on a check after validate-timeout and treats the service as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          })
      )
    );
    const element = mount((el) => {
      el.setAttribute("validate-url", "/api/journey-check");
      el.setAttribute("validate-timeout", "40");
      el.definition = definition();
    });
    const root = await atOverseas(element);
    continueOn(root);
    await until(() => summaryText(root).includes("We could not check your answers. Try again."));
    expect(heading(element)).toBe("Where you live abroad");
  });
});

describe("<datum-form> serverValidator", () => {
  it("wins over validate-url, and is taken up and dropped without a rebuild", async () => {
    const fetchMock = vi.fn(async () => reply(200, { errors: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const element = mount((el) => {
      el.setAttribute("validate-url", "/api/journey-check");
      el.definition = definition();
    });
    const root = await atOverseas(element);
    const runtime = element.runtime;
    const seen: JourneyValidationRequest[] = [];
    const documents: Array<CanonicalSubmission | undefined> = [];
    element.serverValidator = async (request, call) => {
      seen.push(request);
      documents.push(call?.document);
      return { errors: [{ componentId: "country", code: "country.unknown", message: "Unknown to us." }] };
    };
    continueOn(root);
    await until(() => root.textContent?.includes("Unknown to us."));
    // The page's function keeps its request, and is handed the envelope beside it.
    expect(seen).toEqual([
      { formId: "eligibility", formVersion: "3.0.0", journeyId: "apply", scope: "page", pageId: "overseas", values: expect.objectContaining({ country: "Atlantis" }), locale: "en" }
    ]);
    expect(documents[0]?.submission).toMatchObject({ locale: "en", journey: { id: "apply" }, values: { country: "Atlantis" } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(element.runtime).toBe(runtime);

    // Without the property, the URL is the way again.
    element.serverValidator = undefined;
    element.runtime!.setValue("country", "France");
    await new Promise((resolve) => setTimeout(resolve, 0));
    continueOn(root);
    await onPage(element, "How to reach you");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(element.runtime).toBe(runtime);
  });

  it("holds Continue busy while a page's check is out, and locks the form while the journey's end check is", async () => {
    const pageCheck = deferred<JourneyValidationResponse>();
    const endCheck = deferred<JourneyValidationResponse>();
    const element = mount((el) => {
      el.definition = definition(checkedJourney({ validation: { end: "server" } }));
    });
    element.serverValidator = (request) => (request.scope === "page" ? pageCheck.promise : endCheck.promise);
    const submits: DatumFormSubmitDetail[] = [];
    element.addEventListener("datum-submit", (event) => submits.push((event as CustomEvent<DatumFormSubmitDetail>).detail));
    const root = await atOverseas(element, "France");

    continueOn(root);
    // A busy page keeps the button it was pressed with focusable: aria-disabled, never disabled.
    await until(() => root.querySelector("[data-journey-continue]")?.getAttribute("aria-disabled") === "true");
    await until(() => statusLines(root).some((line) => line.includes("Checking your answers")));
    pageCheck.resolve({ errors: [] });
    await onPage(element, "How to reach you");

    element.runtime!.setValue("email", "ada@example.com");
    root.querySelector<HTMLElement>("[data-journey-continue]")!.click();
    await until(() => element.submitting && root.querySelector("form")?.getAttribute("aria-busy") === "true");
    expect(root.querySelector("form[inert], [inert] form, form [inert]")).not.toBeNull();
    // One line speaks for the lock: the submitting line outside the inert form, not a
    // checking line inside it that no one would hear.
    await until(() => root.querySelector("[data-journey-continue]")?.getAttribute("aria-disabled") === "true");
    expect(statusLines(root).some((line) => line.includes("Checking your answers"))).toBe(false);
    expect(statusLines(root).filter((line) => line !== "")).toHaveLength(1);
    expect(root.querySelector("[data-journey-back]")!.getAttribute("aria-disabled")).toBe("true");
    expect(submits).toEqual([]);
    endCheck.resolve({ errors: [] });
    await until(() => submits.length === 1);
    expect(submits[0]!.accepted).toBe(true);
    await until(() => !element.submitting);
  });

  it("holds Back during the journey's end check when the host submits through the runtime itself", async () => {
    const endCheck = deferred<JourneyValidationResponse>();
    const element = mount((el) => {
      el.definition = definition(checkedJourney({ validation: { end: "server" } }));
    });
    element.serverValidator = () => endCheck.promise;
    await onPage(element, "About you");
    element.runtime!.setValue("resident", "yes");
    element.runtime!.setValue("province", "ON");
    element.runtime!.setValue("email", "ada@example.com");
    await element.nextPage();
    await element.nextPage();
    const root = await onPage(element, "How to reach you");
    const runtime = element.runtime!;
    // What `<datum-form-host>` pages do: the runtime's submit, with no lock set on the renderer.
    const submitted = runtime.submit(EMBED_SUBMISSION_MODE, versionContextFor(definition()));
    await until(() => root.querySelector("[data-journey-continue]")?.getAttribute("aria-disabled") === "true");
    expect(element.submitting).toBe(false);
    const back = root.querySelector<HTMLElement>("[data-journey-back]")!;
    expect(back.getAttribute("aria-disabled")).toBe("true");
    // The button stays focusable, so it still receives the click: it is not taken to the runtime, which would refuse it.
    const previous = vi.spyOn(runtime, "previousPage");
    back.click();
    expect(previous).not.toHaveBeenCalled();
    endCheck.resolve({ errors: [] });
    expect((await submitted).accepted).toBe(true);
    await until(() => root.querySelector("[data-journey-back]")?.getAttribute("aria-disabled") === "false");
  });

  it("a download skips the journey's end check: the person keeps a copy, the service judges it when it is sent", async () => {
    const requests: JourneyValidationRequest[] = [];
    const element = mount((el) => {
      el.definition = definition(checkedJourney({ validation: { end: "server" } }));
    });
    element.serverValidator = async (request) => {
      requests.push(request);
      return { errors: [] };
    };
    const downloads: DatumDownloadDetail[] = [];
    element.addEventListener("datum-download", (event) => {
      downloads.push((event as CustomEvent<DatumDownloadDetail>).detail);
      event.preventDefault();
    });
    await onPage(element, "About you");
    element.runtime!.setValue("resident", "yes");
    element.runtime!.setValue("province", "ON");
    element.runtime!.setValue("email", "ada@example.com");
    await element.nextPage();
    await element.nextPage();
    await onPage(element, "How to reach you");

    const detail = await element.submitAndDownload();
    expect(detail.accepted).toBe(true);
    expect(downloads).toHaveLength(1);
    expect(requests.filter((request) => request.scope === "journey")).toEqual([]);

    // A submit asks.
    expect((await element.submit()).accepted).toBe(true);
    expect(requests.filter((request) => request.scope === "journey")).toHaveLength(1);
  });
});

describe("createFetchJourneyValidator", () => {
  const request: JourneyValidationRequest = {
    formId: "eligibility",
    formVersion: "3.0.0",
    journeyId: "apply",
    scope: "page",
    pageId: "about",
    values: { resident: "yes" },
    locale: "fr"
  };
  const document: CanonicalSubmission = {
    versionContext: { form: { id: "eligibility", version: "3.0.0" }, client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1" } },
    submission: { locale: "fr", values: { resident: "yes" }, journey: { id: "apply" } }
  };
  const call = { document };

  it("posts { document, scope, pageId } with the page's headers and credentials, and reads each error's field, code, message and severity", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      reply(200, {
        accepted: false,
        errors: [
          { field: "province", code: "province.closed", message: "Closed.", severity: "error" },
          { field: null, code: "service.busy", severity: "warning" },
          { componentId: "email", field: "ignored", code: "email.taken" }
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const validator = createFetchJourneyValidator("/check", { headers: { authorization: "Bearer t" }, credentials: "include" });
    expect(await validator(request, call)).toEqual({
      errors: [
        { componentId: "province", code: "province.closed", message: "Closed.", severity: "error" },
        { code: "service.busy", severity: "warning" },
        { componentId: "email", code: "email.taken" }
      ]
    });
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json", accept: "application/json", authorization: "Bearer t" });
    expect(init.credentials).toBe("include");
    // The locale travels in the envelope, as on Submit.
    expect(JSON.parse(String(init.body))).toEqual({ document, scope: "page", pageId: "about" });

    // The journey's end check names no page.
    fetchMock.mockClear();
    const { pageId: _page, ...journeyRequest } = request;
    await validator({ ...journeyRequest, scope: "journey" }, call).catch(() => undefined);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ document, scope: "journey" });
  });

  it("reads a 200 accepted as a pass, a 422's errors as a verdict, and a host's notes as warnings", async () => {
    const validator = createFetchJourneyValidator("/check");
    vi.stubGlobal("fetch", vi.fn(async () => reply(200, { accepted: true, errors: [] })));
    expect(await validator(request, call)).toEqual({ errors: [] });

    vi.stubGlobal("fetch", vi.fn(async () => reply(422, { errors: [{ field: "resident", code: "resident.closed", message: "Closed." }] })));
    expect(await validator(request, call)).toEqual({ errors: [{ componentId: "resident", code: "resident.closed", message: "Closed." }] });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(200, { accepted: true, errors: [], notes: [{ field: "resident", code: "resident.late", severity: "info" }, { code: "server.skipped", severity: "error" }] }))
    );
    expect(await validator(request, call)).toEqual({
      errors: [
        { componentId: "resident", code: "resident.late", severity: "info" },
        { code: "server.skipped", severity: "warning" }
      ]
    });
  });

  it("rejects with the status for anything but 200 and 422, and rejects a reply it cannot read", async () => {
    const validator = createFetchJourneyValidator("/check");
    for (const status of [400, 401, 404, 409, 503]) {
      vi.stubGlobal("fetch", vi.fn(async () => reply(status, { errors: [{ code: "bad_document" }] })));
      const failure = await validator(request, call).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(JourneyValidationHttpError);
      expect((failure as JourneyValidationHttpError).status).toBe(status);
    }

    vi.stubGlobal("fetch", vi.fn(async () => reply(201, { errors: [] })));
    expect(((await validator(request, call).catch((error: unknown) => error)) as { status?: number }).status).toBe(201);

    for (const body of [
      { accepted: true },
      { errors: [{ field: "x" }] },
      "not an object",
      // An accepted flag at odds with the errors.
      { accepted: true, errors: [{ field: "resident", code: "resident.closed" }] },
      { accepted: false, errors: [] }
    ]) {
      vi.stubGlobal("fetch", vi.fn(async () => reply(200, body)));
      const malformed = await validator(request, call).catch((error: unknown) => error);
      expect(malformed).toBeInstanceOf(Error);
      expect((malformed as { status?: number }).status).toBeUndefined();
    }
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200 })));
    await expect(validator(request, call)).rejects.toThrow(/not JSON/);
  });

  it("posts nothing for a call with no document", async () => {
    const fetchMock = vi.fn(async () => reply(200, { accepted: true, errors: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createFetchJourneyValidator("/check")(request)).rejects.toThrow(/No document/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
