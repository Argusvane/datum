import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import fixtureText from "../../../fixtures/endpoint-fixture.definition.json?raw";
import goldenText from "../../../golden/abi-4.1.json?raw";
import hostContextText from "../../../src/host-check/fixtures/host-context-form.json?raw";

/**
 * A GOOD host for the kit's self-tests: it answers the five host capabilities the way the Spring
 * examples do (the statuses, codes, headers and bodies the Java kit asserts), judging the fixture's
 * answers with the three rules the golden controls exercise. Every request's raw target is kept, so
 * a test can see that a dot segment left the kit as written. `fault` replaces any answer, which is how
 * the negative tests make one thing wrong at a time.
 *
 * The check route is strict, as the Spring and FastAPI hosts are: the body is `{document, scope, pageId?}`
 * (a bare document, a missing or unknown scope, a page beside `journey`, a `page` with no page are all 400
 * bad_document before the form is looked up), and its verdict is `{accepted, errors}` with blocking errors only.
 * The dry-run route takes the `{document}` wrapper.
 */
export interface MockHostOptions {
  /** The submissions limit per minute (Spring Boot's datum.web.throttle.limit); default 30. */
  floodLimit?: number;
  /**
   * The requests per minute counted by address (Spring Boot's datum.web.throttle.address-limit), before a body is
   * read or parsed; default 200, the setting the kit recommends. 0 turns it off.
   */
  addressLimit?: number;
  /** Routes switched off (a router's own 404, not a Datum error): every Datum route is off until an application switches it on. */
  off?: readonly ("submissions" | "validate" | "test" | "definition" | "assets")[];
  /** The fixture form is installed (default true), and at which version. */
  fixture?: boolean;
  fixtureVersion?: string;
  /**
   * Serves the host context fixture (form datum-host-context) with a test provider that reads the role from
   * X-Datum-Test-Role: `name` is required and `admin_note` is required only under the `admin` role. A request with
   * no header has no context, so the dry run leaves the host-shown field out (visibilitySkipped).
   */
  hostContext?: boolean;
  /** Serves the builder's files. */
  builderEnabled?: boolean;
  /** The cookie-token CSRF recipe: GET / sets XSRF-TOKEN; writes need X-XSRF-TOKEN equal to the cookie. */
  csrf?: boolean;
  /** Replaces an answer: return true when it wrote one. */
  fault?: (request: SeenRequest, response: ServerResponse) => boolean;
}

export interface SeenRequest {
  method: string;
  /** The raw request target, as it came over the wire. */
  target: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

export interface MockHost {
  url: string;
  seen: SeenRequest[];
  close(): Promise<void>;
}

const FORM = "datum-security-suite";
const BUILD = "b1d2c3";
const golden = JSON.parse(goldenText) as { controls: Record<string, { values?: unknown }> };
const fixture = JSON.parse(fixtureText) as Record<string, unknown>;
const HOST_CONTEXT_FORM = "datum-host-context";
const hostContextForm = JSON.parse(hostContextText) as Record<string, unknown>;

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(text);
}

function error(response: ServerResponse, status: number, code: string, headers: Record<string, string> = {}): void {
  json(response, status, { errors: [{ code, message: code }] }, headers);
}

/** The public copy: every rule run on the server ("server-secret") left out, as a host's public copy does. */
function stripSecret(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecret);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if (member !== null && typeof member === "object" && (member as Record<string, unknown>)["run"] === "server-secret") continue;
    out[key] = stripSecret(member);
  }
  return out;
}

/** The three rules of the fixture the golden controls exercise. */
function judge(values: Record<string, unknown>): { field: string; code: string }[] {
  const errors: { field: string; code: string }[] = [];
  const name = values["name"];
  if (typeof name !== "string" || name === "") errors.push({ field: "name", code: "required" });
  else if (name.length > 40) errors.push({ field: "name", code: "maxLength" });
  if (typeof values["code"] !== "string" || !/^[A-Z]{2}\d{4}$/.test(values["code"] as string)) errors.push({ field: "code", code: "pattern" });
  return errors;
}

/** The values the golden file keeps for CTL-01. */
export const GOLDEN_CTL01_VALUES: unknown = golden.controls["CTL-01"]?.values;

/** The dry-run route's one flat report, all fourteen members (the Spring Boot host's shape), for the answers the mock gives. */
export function dryRunReport(
  values: Record<string, unknown>,
  errors: { field: string; code: string }[],
  extra: { values?: unknown; visibilitySkipped?: string[] } = {}
): Record<string, unknown> {
  const rejected = errors.length > 0;
  const document = JSON.stringify({ values });
  return {
    outcome: rejected ? "rejected" : "accepted",
    stage: rejected ? "sandbox" : null,
    errors: errors.map((error) => ({ field: error.field, code: error.code, message: null, severity: "error", stage: null, source: null })),
    sent: values,
    values: "values" in extra ? extra.values : rejected ? null : values,
    clientDerived: [],
    clockDependent: [],
    serverRules: [],
    visibilitySkipped: extra.visibilitySkipped ?? [],
    document,
    digest: createHash("sha256").update(document).digest("hex"),
    logs: [],
    sandbox: { elapsedMs: 0.1, rules: [], unknownFields: null, logLevel: null },
    signature: null
  };
}

export async function startMockHost(options: MockHostOptions = {}): Promise<MockHost> {
  const seen: SeenRequest[] = [];
  const receipts = new Map<string, { id: string; reference: string; digest: string }>();
  const limit = options.floodLimit ?? 30;
  let submits = 0;
  let addressed = 0;
  const addressLimit = options.addressLimit ?? 200;
  const version = options.fixtureVersion ?? "1";
  const publicCopy = { ...stripSecret(fixture) as Record<string, unknown>, version };
  const publicText = JSON.stringify(publicCopy);
  const etag = `"${createHash("sha256").update(publicText).digest("hex")}"`;
  const token = randomUUID();

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const target = request.url ?? "/";
      const method = request.method ?? "GET";
      const entry: SeenRequest = { method, target, headers: request.headers, body };
      seen.push(entry);
      if (options.fault?.(entry, response) === true) return;
      route(entry, response);
    });
  });

  /** `{document, scope: journey | page, pageId?}`: a journey names no page, a page names one. */
  function strictCheck(parsed: Record<string, unknown>): boolean {
    const document = parsed["document"];
    if (document === null || typeof document !== "object" || Array.isArray(document)) return false;
    if (parsed["scope"] === "journey") return parsed["pageId"] === undefined;
    return parsed["scope"] === "page" && typeof parsed["pageId"] === "string" && parsed["pageId"] !== "";
  }

  /** The host context fixture, judged under the role the test provider reads from the header (none: no context). */
  function hostContextAnswer(path: string, values: Record<string, unknown>, parsed: Record<string, unknown>, headers: IncomingMessage["headers"], response: ServerResponse): void {
    const role = headers["x-datum-test-role"];
    const errors: { field: string; code: string }[] = [];
    if (typeof values["name"] !== "string" || values["name"] === "") errors.push({ field: "name", code: "required" });
    if (role === "admin" && (typeof values["admin_note"] !== "string" || values["admin_note"] === "")) errors.push({ field: "admin_note", code: "required" });
    if (path === "/api/submissions/validate") {
      json(response, 200, { accepted: errors.length === 0, errors });
      return;
    }
    if (path === "/api/submissions/test") {
      // The host-shown field is stored only when a context shows it; whatever the client wrote under `host` never counts.
      const kept: Record<string, unknown> = { name: values["name"] };
      if (role === "admin" && values["admin_note"] !== undefined) kept["admin_note"] = values["admin_note"];
      json(response, 200, dryRunReport(values, errors, { values: kept, visibilitySkipped: role === undefined ? ["admin_note"] : [] }));
      return;
    }
    if (typeof parsed["submissionKey"] !== "string") {
      error(response, 400, "bad_document");
      return;
    }
    if (errors.length > 0) {
      json(response, 422, { errors });
      return;
    }
    json(response, 200, { status: "accepted", id: randomUUID(), reference: "HC-1", digest: createHash("sha256").update(JSON.stringify(parsed)).digest("hex"), handled: false });
  }

  function route({ method, target, headers, body }: SeenRequest, response: ServerResponse): void {
    const path = target.split("?")[0] as string;
    const off = options.off ?? [];
    const switchedOff =
      (off.includes("submissions") && path === "/api/submissions") ||
      (off.includes("validate") && path === "/api/submissions/validate") ||
      (off.includes("test") && path === "/api/submissions/test") ||
      (off.includes("definition") && /^\/api\/forms\/[^/]+\/definition$/.test(path)) ||
      (off.includes("assets") && path.startsWith("/datum/assets/"));
    if (switchedOff) {
      json(response, 404, { timestamp: new Date().toISOString(), status: 404, error: "Not Found", path });
      return;
    }
    if (options.csrf === true && method !== "GET" && method !== "HEAD") {
      const cookie = headers["cookie"] ?? "";
      if (!cookie.includes(`XSRF-TOKEN=${token}`) || headers["x-xsrf-token"] !== token) {
        error(response, 403, "csrf");
        return;
      }
    }
    if (method === "GET" && path === "/") {
      response.writeHead(200, { "Content-Type": "text/html", ...(options.csrf === true ? { "Set-Cookie": `XSRF-TOKEN=${token}; Path=/` } : {}) });
      response.end("<html></html>");
      return;
    }
    // A dot segment never reaches the assets: a servlet container refuses it first (400).
    if (/(^|\/)(\.\.|%2e%2e)(\/|$)/i.test(path)) {
      response.writeHead(400, { "Content-Type": "text/html" });
      response.end("<html>Bad Request</html>");
      return;
    }
    const definition = /^\/api\/forms\/([^/]+)\/definition$/.exec(path);
    if (method === "GET" && definition !== null) {
      const key = decodeURIComponent(definition[1] as string);
      const [id, at] = key.split("@");
      // The author's copy is the builder's: with the builder off the host answers 404 for any key.
      if (options.builderEnabled !== true && target.split("?")[1] === "public=false") {
        error(response, 404, "form.notFound");
        return;
      }
      if (options.hostContext === true && id === HOST_CONTEXT_FORM && (at === undefined || at === "1")) {
        json(response, 200, hostContextForm);
        return;
      }
      if (options.fixture === false || id !== FORM || (at !== undefined && at !== version)) {
        error(response, 404, "form.notFound");
        return;
      }
      if (headers["if-none-match"] === etag) {
        response.writeHead(304, { ETag: etag });
        response.end();
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json", ETag: etag });
      response.end(publicText);
      return;
    }
    if (method === "POST" && (path === "/api/submissions" || path === "/api/submissions/validate" || path === "/api/submissions/test")) {
      if (!(headers["content-type"] ?? "").startsWith("application/json")) {
        error(response, 415, "unsupported_media_type");
        return;
      }
      // Every counted request counts by its address before its body is read, whether or not the body parses.
      addressed += 1;
      if (addressLimit > 0 && addressed > addressLimit) {
        error(response, 429, "flood", { "Retry-After": "60" });
        return;
      }
      if (body.length > 1024 * 1024) {
        error(response, 413, "bad_document");
        return;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      } catch {
        error(response, 400, "bad_document");
        return;
      }
      // The check is strict about its request before the form is looked up.
      if (path === "/api/submissions/validate" && !strictCheck(parsed)) {
        error(response, 400, "bad_document");
        return;
      }
      const document = (parsed["document"] ?? parsed) as { versionContext?: { form?: { id?: string; version?: string } }; submission?: { values?: Record<string, unknown> } };
      const form = document.versionContext?.form;
      if (options.hostContext === true && form?.id === HOST_CONTEXT_FORM) {
        hostContextAnswer(path, document.submission?.values ?? {}, parsed, headers, response);
        return;
      }
      if (options.fixture === false || form?.id !== FORM) {
        error(response, 404, "form.notFound");
        return;
      }
      if (path === "/api/submissions") {
        submits += 1;
        if (submits > limit) {
          error(response, 429, "flood", { "Retry-After": "60" });
          return;
        }
      }
      if (form.version !== version) {
        error(response, 409, "form.outdated");
        return;
      }
      const submissionKey = parsed["submissionKey"];
      if (path === "/api/submissions" && (parsed["document"] === undefined || typeof submissionKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(submissionKey))) {
        error(response, 400, "bad_document");
        return;
      }
      const errors = judge(document.submission?.values ?? {});
      if (path === "/api/submissions/validate") {
        json(response, 200, { accepted: errors.length === 0, errors });
        return;
      }
      if (path === "/api/submissions/test") {
        json(response, 200, dryRunReport(document.submission?.values ?? {}, errors, { values: golden.controls["CTL-01"]?.values }));
        return;
      }
      // A known key is answered before the document is judged: the conflict even for a document the form refuses.
      const digest = createHash("sha256").update(JSON.stringify(document)).digest("hex");
      const known = receipts.get(String(submissionKey));
      if (known !== undefined) {
        if (known.digest !== digest) {
          error(response, 409, "submission.keyConflict");
          return;
        }
        json(response, 200, { status: "accepted", ...known, handled: true });
        return;
      }
      if (errors.length > 0) {
        json(response, 422, { errors });
        return;
      }
      const receipt = { id: randomUUID(), reference: `SUB-${receipts.size + 1}`, digest };
      receipts.set(String(submissionKey), receipt);
      json(response, 200, { status: "accepted", ...receipt, handled: false });
      return;
    }
    if (method === "GET" && path === "/datum/assets/host.json") {
      json(response, 200, { buildId: BUILD, assetsBase: `/datum/assets/${BUILD}`, apiBase: "/api", csrf: { headerName: null } });
      return;
    }
    if (method === "GET" && path === "/datum/assets/datum-host.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end("window.DatumHost = { headers: ['If-Match'] };");
      return;
    }
    const asset = /^\/datum\/assets\/([^/]+)\/(.+)$/.exec(path);
    if (method === "GET" && asset !== null && asset[1] === BUILD) {
      const file = asset[2] as string;
      const served = ["datum-form.js", "datum-wasm.js", ...(options.builderEnabled === true ? ["datum-builder.js"] : [])];
      if (served.includes(file)) {
        response.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=31536000, immutable" });
        response.end(`// ${file}`);
        return;
      }
    }
    error(response, 404, "not_found");
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}
