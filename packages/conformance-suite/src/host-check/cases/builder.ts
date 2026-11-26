import { hostCase, type CapabilityModule, type CaseContext, type Probe, type ProbeContext, type ProbeOutcome } from "../case.js";
import { check, expectCode, expectEqual, expectHeader, expectMatches, expectStatus, textAt } from "../expect.js";
import { asString, isRecord, path } from "../json.js";
import { TransportError, type Reply } from "../http.js";
import { CSRF_TOKEN, REACHABLE } from "../preflight.js";
import type { Who } from "../target.js";

/**
 * BLD: the builder's write routes over a form the host lets the PERSON persona build (--build-form;
 * the Java kit's BuilderContract, @Order 1701-1704). Only someone who may build saves (the visitor and
 * the other person are refused 401 or 403 by the host's own security, body unchecked, since the framework owns
 * access refusals; Datum's JSON handlers answer access.denied), a save names its version with If-Match and
 * answers the new ETag, a page that fell behind is told 409 form.outdated, the kernel refuses a risky
 * pattern and a duplicate id (422) before anything is stored, a body whose id is not the key is 422,
 * and creating an id that exists is 409 form.exists. The host's own storage checks stay with the host.
 * Without --build-form the whole group is skipped (the Java assumeTrue), and the host is not touched.
 */
type Definition = Record<string, unknown>;

function formOf(context: CaseContext): string {
  const form = context.target.buildForm;
  if (form === undefined) throw new Error("--build-form is missing; the capability's assumption should have skipped the group");
  return form;
}

/** `GET <api>/forms/{form}/definition?public=false` as the person, 200 with an ETag (BuilderContract.load). */
async function load(context: CaseContext): Promise<Reply> {
  const loaded = await context.http.get(context.api(`/forms/${formOf(context)}/definition?public=false`), "person");
  expectStatus(loaded, 200, "load");
  expectHeader(loaded, "ETag", undefined, "load");
  return loaded;
}

/** An editable copy of the loaded definition (the cached parse is shared by the Reply). */
function copy(reply: Reply): Definition {
  return structuredClone(reply.json()) as Definition;
}

function put(context: CaseContext, key: string, definition: Definition, who: Who, ifMatch: string | undefined): Promise<Reply> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (ifMatch !== undefined) headers["If-Match"] = ifMatch;
  return context.http.send("PUT", context.api(`/forms/${key}`), { contentType: "application/json", body: JSON.stringify(definition), who, headers });
}

/** `root.children.content` (an array the cases add to). */
function content(definition: Definition): unknown[] {
  const found = path(definition, "root", "children", "content");
  check(Array.isArray(found), () => `the form has no root.children.content array: ${JSON.stringify(path(definition, "root", "children")).slice(0, 200)}`);
  return found as unknown[];
}

function codes(reply: Reply): string[] {
  const errors = path(reply.json(), "errors");
  return [...new Set(Array.isArray(errors) ? errors.map((error) => asString(path(error, "code"))) : [])].sort();
}

/**
 * The person can read the build form's author copy. A host that serves it only to signed-in people
 * answers 401/403 for the wrong persona headers, which is the run's set-up (--person-header), not the
 * host's wire contract.
 */
const BUILD_FORM: Probe = {
  id: "build-form",
  checks: "GET <api>/forms/<build-form>/definition?public=false as the person answers 200 (the builder is on, the form is installed, the person may build)",
  async run(context: ProbeContext): Promise<ProbeOutcome> {
    const form = context.target.buildForm;
    if (form === undefined) return { status: "missing", message: "--build-form is not given" };
    let reply;
    try {
      reply = await context.probe("GET", context.api(`/forms/${form}/definition?public=false`), { who: "person" });
    } catch (error) {
      if (error instanceof TransportError) return { status: "missing", message: `cannot reach ${context.target.baseUrl}: ${error.message}` };
      throw error;
    }
    const code = reply.isJson() ? asString(path(reply.json(), "errors", 0, "code")) : "";
    if (reply.status === 200) return { status: "ok", message: `the person reads ${form}'s author copy` };
    if (reply.status === 404 && code === "") {
      return { status: "missing", message: `the definition route is off (GET ${reply.path} -> 404): switch it on for this test deployment (Spring Boot: datum.web.api.endpoints.definition=true, datum.builder.enabled=true) or leave builder out of --capabilities` };
    }
    if (reply.status === 404) return { status: "missing", message: `the build form ${form} is not installed (GET ${reply.path} -> 404 ${code}): install it or name another with --build-form` };
    if (reply.status === 401 || reply.status === 403) {
      return { status: "missing", message: `the person may not read ${form}'s author copy (GET ${reply.path} -> ${reply.status}): give --person-header the credentials of someone who may build, and switch the builder on (Spring Boot: datum.builder.enabled=true)` };
    }
    return { status: "unknown", message: `GET ${reply.path} -> ${reply.status}${code !== "" ? ` ${code}` : ""}, not 200; the cases will tell` };
  }
};

export const BUILDER: CapabilityModule = {
  capability: "builder",
  probes: [REACHABLE, CSRF_TOKEN, BUILD_FORM],
  assumption: (target) => (target.buildForm === undefined ? "the host names no form a person may build (--build-form)" : undefined),
  cases: [
    hostCase({
      id: "BLD-01",
      capability: "builder",
      order: 1701,
      oracle: "BuilderContract#onlySomeoneWhoMayBuildSaves",
      expects: "PUT <api>/forms/<build-form> with the loaded definition and If-Match as the visitor and as the other person -> 401 or 403 each (the host's security; body unchecked); the stored form's ETag is unchanged",
      async run(context) {
        const loaded = await load(context);
        const definition = copy(loaded);
        const etag = expectHeader(loaded, "ETag");
        for (const who of ["visitor", "other-person"] as const) {
          const refused = await put(context, formOf(context), definition, who, etag);
          // The host's own security refuses (the framework owns access refusals): 401 or 403, the body unchecked, since a
          // framework's default handler writes none (Datum's JSON handlers write access.denied when installed).
          expectStatus(refused, [401, 403], `${who}`);
        }
        expectEqual((await load(context)).header("ETag"), loaded.header("ETag"), "the stored form's ETag after the refusals");
      }
    }),
    hostCase({
      id: "BLD-02",
      capability: "builder",
      order: 1702,
      oracle: "BuilderContract#aSaveAnswersItsTagAndAPageThatFellBehindIsTold409",
      expects: 'PUT with a new version and If-Match as the person -> 200, sha256 (64 hex) and ETag "<sha256>", the next load carries it; the same If-Match again -> 409 form.outdated with the current ETag',
      async run(context) {
        const loaded = await load(context);
        const definition = copy(loaded);
        const etag = expectHeader(loaded, "ETag");
        definition["version"] = `tck-${process.hrtime.bigint()}`;
        const saved = await put(context, formOf(context), definition, "person", etag);
        expectStatus(saved, 200, "the save");
        const sha = textAt(saved.json(), "sha256");
        expectMatches(sha, /[0-9a-f]{64}/, "sha256");
        expectEqual(saved.header("ETag"), `"${sha}"`, "the save's ETag");
        expectEqual((await load(context)).header("ETag"), saved.header("ETag"), "the next load's ETag");

        const stale = await put(context, formOf(context), definition, "person", etag);
        expectStatus(stale, 409, "the stale save");
        expectCode(stale, "form.outdated", "the stale save");
        expectEqual(stale.header("ETag"), saved.header("ETag"), "the stale save's ETag");
      }
    }),
    hostCase({
      id: "BLD-03",
      capability: "builder",
      order: 1703,
      oracle: "BuilderContract#theKernelRefusesARiskyPatternAndDuplicateIdsAndNothingIsStored",
      expects: "PUT a text component whose visibleWhen formula is matches(name, \"(a|a?)+\") -> 422 pattern.risky, kernel[0].where rules:tckfx:visibleWhen; two components with id tckdup -> 422 component.id.duplicate; the stored ETag is unchanged",
      async run(context) {
        const loaded = await load(context);
        const etag = expectHeader(loaded, "ETag");
        const risky = copy(loaded);
        content(risky).push({
          id: "tckfx",
          type: "text",
          configuration: {},
          rules: { visibleWhen: { run: "both", formula: 'matches(name, "(a|a?)+")' } }
        });
        const refused = await put(context, formOf(context), risky, "person", etag);
        expectStatus(refused, 422, "the risky pattern");
        expectCode(refused, "pattern.risky", "the risky pattern");
        expectEqual(textAt(refused.json(), "kernel", 0, "where"), "rules:tckfx:visibleWhen", "kernel[0].where");

        const duplicates = copy(loaded);
        for (let i = 0; i < 2; i += 1) content(duplicates).push({ id: "tckdup", type: "text", configuration: {} });
        const duplicate = await put(context, formOf(context), duplicates, "person", etag);
        expectStatus(duplicate, 422, "the duplicate id");
        expectCode(duplicate, "component.id.duplicate", "the duplicate id");
        expectEqual((await load(context)).header("ETag"), loaded.header("ETag"), "the stored form is the one from before");
      }
    }),
    hostCase({
      id: "BLD-04",
      capability: "builder",
      order: 1704,
      oracle: "BuilderContract#aBodyWhoseIdIsNotTheKeyIs422AndCreatingAnIdThatExistsIs409",
      expects: "PUT <build-form> with id <build-form>-other -> 422 with definition.id.mismatch among its codes; POST <api>/forms with the existing definition -> 409 form.exists",
      async run(context) {
        const loaded = await load(context);
        const other = copy(loaded);
        other["id"] = `${formOf(context)}-other`;
        const mismatch = await put(context, formOf(context), other, "person", expectHeader(loaded, "ETag"));
        expectStatus(mismatch, 422, "the id mismatch");
        const found = codes(mismatch);
        check(found.includes("definition.id.mismatch"), () => `the id mismatch: expected definition.id.mismatch among [${found.join(", ")}] in ${mismatch.describe()}`);

        const exists = await context.http.send("POST", context.api("/forms"), {
          contentType: "application/json",
          body: JSON.stringify(loaded.json()),
          who: "person",
          headers: { Accept: "application/json" }
        });
        expectStatus(exists, 409, "creating an id that exists");
        expectCode(exists, "form.exists", "creating an id that exists");
        check(isRecord(loaded.json()), "the loaded definition is an object");
      }
    })
  ]
};
