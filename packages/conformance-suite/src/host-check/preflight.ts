import type { Probe, ProbeContext, ProbeOutcome } from "./case.js";
import { checked, envelope, FORM, HOST_CONTEXT_FORM, HOST_CONTEXT_VERSION, SECRET_MARKER, VERSION } from "./fixtures.js";
import { TransportError } from "./http.js";
import { asString, isRecord, path } from "./json.js";

/**
 * The probes the capabilities share. The run is INCONCLUSIVE (exit 3) when a probe finds the set-up
 * missing, and says which: a host that does not serve the fixture form, or has a switch off, would
 * otherwise fail cases for a reason that is not a fault of the host's wire contract.
 */

/** The host answers at all (any HTTP status): a run against a host that is not there is inconclusive, never a failure. */
export const REACHABLE: Probe = {
  id: "reachable",
  checks: "GET <endpoint>/ answers with any HTTP status",
  async run(context: ProbeContext): Promise<ProbeOutcome> {
    try {
      const reply = await context.probe("GET", `${context.target.baseUrl}/`);
      return { status: "ok", message: `the host answers (GET / -> ${reply.status})` };
    } catch (error) {
      return { status: "missing", message: `cannot reach ${context.target.baseUrl}: ${error instanceof Error ? error.message : String(error)}. Check --endpoint and that the host is running.` };
    }
  }
};

/**
 * The `--csrf` recipe can be followed: `GET <endpoint>/` hands the visitor the named token cookie. A host
 * without one would fail every write case for a reason that is the set-up's (a recipe the host does not
 * use), not its wire contract's. Without `--csrf` there is nothing to check. Every capability that writes,
 * its probes included, lists this probe before its first POST.
 */
export const CSRF_TOKEN: Probe = {
  id: "csrf-token",
  checks: "with --csrf cookie:<cookie>:<header>, GET <endpoint>/ sets the named token cookie",
  async run(context: ProbeContext): Promise<ProbeOutcome> {
    const recipe = context.target.csrf;
    if (recipe === undefined) return { status: "ok", message: "no --csrf recipe given" };
    let token;
    try {
      token = await context.csrfToken("visitor");
    } catch (error) {
      if (error instanceof TransportError) return { status: "missing", message: `cannot reach ${context.target.baseUrl}: ${error.message}` };
      throw error;
    }
    return token !== undefined
      ? { status: "ok", message: `GET / hands out the ${recipe.cookie} cookie` }
      : {
          status: "missing",
          message: `--csrf names the cookie ${recipe.cookie}, but GET ${context.target.baseUrl}/ sets none: drop --csrf when the host checks no CSRF token, or name the cookie its CSRF filter sets (Spring Security: CookieCsrfTokenRepository, XSRF-TOKEN)`
        };
  }
};

/**
 * The code of a Datum error body (`{errors: [{code}]}`), or "" when the body is not one. A switched-off
 * route is answered by the router or the framework's default error page (Spring Boot's
 * `{timestamp, status, error, path}`, an HTML page, nothing), never with a Datum code: Datum's error
 * handlers answer only Datum's own routes (DatumMvcExceptionHandler is limited to @DatumController,
 * DatumWebFluxExceptionHandler to the registered routes). So a 404 that does carry a Datum code comes from
 * a route that is on, and the cases, not the preflight, judge it.
 */
function datumCode(reply: { isJson(): boolean; json(): unknown }): string {
  return reply.isJson() ? asString(path(reply.json(), "errors", 0, "code")) : "";
}

/**
 * A POST route is switched on: a text/plain body is refused 415 before a byte is read (no run, nothing the
 * throttle counts), and a route that is off answers 404. Every Datum route is off until the application
 * switches it on (every endpoint is off by default), so a missing switch is named here
 * rather than read as a host fault by the cases. Only a 404 without a Datum code means "off": a 404 with
 * one is a route that is on and answers wrongly, which SUB-04 (or DRY-01) then fails.
 */
function postRouteSwitch(id: string, path: string, what: string, property: string): Probe {
  return {
    id,
    checks: `POST <api>${path} with Content-Type text/plain answers 415 (${what} is on), not 404`,
    async run(context: ProbeContext): Promise<ProbeOutcome> {
      let reply;
      try {
        reply = await context.probe("POST", context.api(path), { contentType: "text/plain", body: "{}" });
      } catch (error) {
        if (error instanceof TransportError) return { status: "missing", message: `cannot reach ${context.target.baseUrl}: ${error.message}` };
        throw error;
      }
      const code = datumCode(reply);
      if (reply.status === 404 && code === "") {
        return { status: "missing", message: `${what} is off (POST ${reply.path} -> 404): switch it on for this test deployment (Spring Boot: ${property}=true) or leave the capability out of --capabilities` };
      }
      if (reply.status === 415) return { status: "ok", message: `${what} is on` };
      return {
        status: "unknown",
        message: `POST ${reply.path} as text/plain -> ${reply.status}${code !== "" ? ` ${code}` : ""}, not 415; the cases will tell${reply.status === 404 ? ` (a Datum 404, so the route is on; if it is meant to be off, ${property})` : ""}`
      };
    }
  };
}

/** The receiving route, `POST /submissions`. */
export const SUBMIT_ROUTE = postRouteSwitch("submit-route", "/submissions", "the submissions route", "datum.web.api.endpoints.submissions");

/** The check route, `POST /submissions/validate`. */
export const VALIDATE_ROUTE = postRouteSwitch("validate-route", "/submissions/validate", "the validate route", "datum.web.api.endpoints.validate");

/** The dry-run route, `POST /submissions/test` (Spring Boot: datum.web.api.endpoints.test, off unless asked for). */
export const DRY_RUN_SWITCH = postRouteSwitch("dry-run-switch", "/submissions/test", "the dry-run route", "datum.web.api.endpoints.test");

/**
 * The definition route answers a form that does not exist with Datum's 404 form.notFound, not a router's
 * 404. A 404 with another Datum code is a route that is on and answers wrongly: FRM-03 fails on it, so the
 * probe leaves it to the cases rather than call the switch off (the Java kit reports that FAIL too).
 */
export const DEFINITION_ROUTE: Probe = {
  id: "definition-route",
  checks: "GET <api>/forms/datum-tck-no-such-form/definition answers Datum's 404 form.notFound (the definition route is on)",
  async run(context: ProbeContext): Promise<ProbeOutcome> {
    let reply;
    try {
      reply = await context.probe("GET", context.api("/forms/datum-tck-no-such-form/definition"));
    } catch (error) {
      if (error instanceof TransportError) return { status: "missing", message: `cannot reach ${context.target.baseUrl}: ${error.message}` };
      throw error;
    }
    const code = datumCode(reply);
    if (reply.status === 404 && code === "") {
      return {
        status: "missing",
        message: `the definition route is off (GET ${reply.path} -> 404 without a Datum error code): switch it on for this test deployment (Spring Boot: datum.web.api.endpoints.definition=true) or leave forms out of --capabilities`
      };
    }
    if (reply.status === 404 && code === "form.notFound") return { status: "ok", message: "the definition route is on" };
    return { status: "unknown", message: `GET ${reply.path} -> ${reply.status}${code !== "" ? ` ${code}` : ""}, not 404 form.notFound; the cases will tell` };
  }
};

/** The asset routes answer host.json. */
export const ASSETS_ROUTE: Probe = {
  id: "assets-route",
  checks: "GET <assets>/host.json does not answer 404 (the asset routes are on)",
  async run(context: ProbeContext): Promise<ProbeOutcome> {
    let reply;
    try {
      reply = await context.probe("GET", `${context.target.assetsPath}/host.json`);
    } catch (error) {
      if (error instanceof TransportError) return { status: "missing", message: `cannot reach ${context.target.baseUrl}: ${error.message}` };
      throw error;
    }
    if (reply.status === 404) {
      return {
        status: "missing",
        message: `the asset routes are off or elsewhere (GET ${reply.path} -> 404): switch them on (Spring Boot: datum.web.assets.enabled=true), pass --assets-path, or leave assets out of --capabilities`
      };
    }
    return reply.status === 200 ? { status: "ok", message: "the asset routes are on" } : { status: "unknown", message: `GET ${reply.path} -> ${reply.status}; the cases will tell` };
  }
};

/**
 * The fixture form `datum-security-suite` is served at version 1 (its public definition carries the suite's
 * fixture marker). When the definition route is off, a check of the CTL-01 document on the validate route says
 * whether the form is there (404 form.notFound when it is not).
 */
export const FIXTURE_FORM: Probe = {
  id: "fixture-form",
  checks: `GET <api>/forms/${FORM}/definition answers the kit's fixture form at version ${VERSION}`,
  async run(context: ProbeContext): Promise<ProbeOutcome> {
    const url = context.api(`/forms/${FORM}/definition`);
    let reply;
    try {
      reply = await context.probe("GET", url);
    } catch (error) {
      if (error instanceof TransportError) return { status: "missing", message: `cannot reach ${context.target.baseUrl}: ${error.message}` };
      throw error;
    }
    const install = `install it: \`datum-host-check fixtures --out <dir>\` writes fixture-form.json (Spring Boot: add file:<dir>/fixture-form.json to datum.forms.locations)`;
    const body: unknown = reply.isJson() ? reply.json() : undefined;
    if (reply.status === 404 && asString(path(body, "errors", 0, "code")) === "form.notFound") {
      return { status: "missing", message: `the fixture form ${FORM} is not installed (GET ${reply.path} -> 404 form.notFound): ${install}` };
    }
    if (reply.status === 404) {
      // The definition route is off: ask the validate route instead.
      let check;
      try {
        // The check is strict about its request ({document, scope}): a bare or scope-less body is a 400 before the form is looked up.
        const document = envelope("CTL-01");
        (document["submission"] as Record<string, unknown>)["journey"] = { id: "main" };
        check = await context.probe("POST", context.api("/submissions/validate"), { contentType: "application/json", body: checked(document, "journey") });
      } catch (error) {
        if (error instanceof TransportError) return { status: "missing", message: `cannot reach ${context.target.baseUrl}: ${error.message}` };
        throw error;
      }
      if (check.status === 404 && check.isJson() && asString(path(check.json(), "errors", 0, "code")) === "form.notFound") {
        return { status: "missing", message: `the fixture form ${FORM} is not installed (POST ${check.path} -> 404 form.notFound): ${install}` };
      }
      if (check.status === 409) {
        return { status: "missing", message: `the host serves ${FORM} at another version than ${VERSION} (POST ${check.path} -> 409): ${install}` };
      }
      return check.status === 200
        ? { status: "ok", message: `the fixture form ${FORM} v${VERSION} answers a check (the definition route is off)` }
        : { status: "unknown", message: `the fixture form could not be read (GET ${reply.path} -> 404, POST ${check.path} -> ${check.status}); the cases will tell` };
    }
    if (reply.status !== 200 || !isRecord(body)) {
      return { status: "unknown", message: `the fixture form could not be read (GET ${reply.path} -> ${reply.status}); the cases will tell` };
    }
    if (asString(body["id"]) !== FORM) {
      return { status: "unknown", message: `GET ${reply.path} answered a definition whose id is ${JSON.stringify(body["id"])}; the cases will tell` };
    }
    if (asString(body["version"]) !== VERSION) {
      return {
        status: "missing",
        message: `the host serves ${FORM} at version ${JSON.stringify(asString(body["version"]))}; the cases post version ${VERSION}: ${install}`
      };
    }
    if (asString(path(body, "root", "configuration", "securitySuiteFixture")) !== "1") {
      return { status: "missing", message: `the form ${FORM} the host serves is not the kit's fixture (root.configuration.securitySuiteFixture is not "1"): ${install}` };
    }
    if (reply.text().includes(SECRET_MARKER)) {
      // Not a set-up problem: FRM-01 fails on it. The probe only reports that the fixture is there.
      return { status: "ok", message: `the fixture form ${FORM} v${VERSION} is served (and its public copy leaks the server-secret rule: FRM-01 will fail)` };
    }
    return { status: "ok", message: `the fixture form ${FORM} v${VERSION} is served` };
  }
};

/**
 * The host context fixture `datum-host-context` is served at version 1 (its public definition names the `host.role` rule).
 * The host-context capability needs it beside the first fixture, a dry-run route that is on, and a TEST-ONLY provider
 * for the `X-Datum-Test-Role` header; the provider cannot be probed without a role, so the cases tell.
 */
export const HOST_CONTEXT_FORM_PROBE: Probe = {
  id: "host-context-form",
  checks: `GET <api>/forms/${HOST_CONTEXT_FORM}/definition answers the kit's host context fixture at version ${HOST_CONTEXT_VERSION}`,
  async run(context: ProbeContext): Promise<ProbeOutcome> {
    const url = context.api(`/forms/${HOST_CONTEXT_FORM}/definition`);
    let reply;
    try {
      reply = await context.probe("GET", url);
    } catch (error) {
      if (error instanceof TransportError) return { status: "missing", message: `cannot reach ${context.target.baseUrl}: ${error.message}` };
      throw error;
    }
    const install = `install it: \`datum-host-check fixtures --out <dir>\` writes fixture-host-context-form.json (Spring Boot: add file:<dir>/fixture-host-context-form.json to datum.forms.locations)`;
    const body: unknown = reply.isJson() ? reply.json() : undefined;
    if (reply.status === 404 && asString(path(body, "errors", 0, "code")) === "form.notFound") {
      return { status: "missing", message: `the host context fixture ${HOST_CONTEXT_FORM} is not installed (GET ${reply.path} -> 404 form.notFound): ${install}` };
    }
    if (reply.status === 404) {
      // The definition route is off: a check of a document for the form says whether it is there.
      return { status: "unknown", message: `the host context fixture could not be read (GET ${reply.path} -> 404, the definition route is off); the cases will tell` };
    }
    if (reply.status !== 200 || !isRecord(body)) {
      return { status: "unknown", message: `the host context fixture could not be read (GET ${reply.path} -> ${reply.status}); the cases will tell` };
    }
    if (asString(body["id"]) !== HOST_CONTEXT_FORM) {
      return { status: "unknown", message: `GET ${reply.path} answered a definition whose id is ${JSON.stringify(body["id"])}; the cases will tell` };
    }
    if (asString(body["version"]) !== HOST_CONTEXT_VERSION) {
      return { status: "missing", message: `the host serves ${HOST_CONTEXT_FORM} at version ${JSON.stringify(asString(body["version"]))}; the cases post version ${HOST_CONTEXT_VERSION}: ${install}` };
    }
    return { status: "ok", message: `the host context fixture ${HOST_CONTEXT_FORM} v${HOST_CONTEXT_VERSION} is served` };
  }
};
