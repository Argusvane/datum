import { Agent as HttpAgent, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";

import { CaseFailure } from "./expect.js";
import { asString, path } from "./json.js";
import type { HostTarget, Who } from "./target.js";
import { KIT_VERSION } from "./version.js";

/**
 * Requests to the host under test: the port of the Java kit's HostHttp and Reply, plus the two
 * rules every reply meets before a case sees it (the security suite's never-500 rule, wire.ts):
 *
 *  - any 5xx but a typed 503 (a Datum error body `{errors: [{code}]}` whose code is one of
 *    TYPED_503_CODES) fails the case;
 *  - on a JSON route (under the API or WebAuthn path unless the case says otherwise) a body that is
 *    not JSON fails the case, except the empty 204/304, the 404/405/413 a router or proxy may answer
 *    in its own format (the suite's NON_JSON_OK), and the 401/403 of the application's own security.
 *
 * Built on node:http and node:https, not fetch: the WHATWG URL parser behind fetch rewrites dot
 * segments (`sub/../x`, `%2e%2e`) before the request leaves, and the assets cases exist to send
 * exactly those spellings, as the Java kit's HttpClient does. Redirects are never followed (a case
 * asserts the first answer). Each persona keeps a cookie jar when `--csrf` is given, so a token the
 * host hands out is tracked; only that token cookie goes back, as the Java example ITs send it.
 */

/** A request that never produced an HTTP answer (refused, reset, timed out). A case FAILs on it, as on the Java kit's UncheckedIOException. */
export class TransportError extends CaseFailure {
  constructor(
    message: string,
    public readonly timedOut: boolean
  ) {
    super(message);
    this.name = "TransportError";
  }
}

/**
 * The answers that may come in the framework's own format on a JSON route: a router's or proxy's
 * 404/405/413 (the suite's NON_JSON_OK), and the 401/403 of the application's security. Access
 * refusals belong to the framework (both kits accept 401 or
 * 403 there); a case that needs Datum's JSON access.denied still asserts it with expectCode.
 */
const NON_JSON_TOLERATED = new Set([401, 403, 404, 405, 413]);

/**
 * The codes a typed 503 may carry, an explicit list as the endpoint mode keeps one (wire.ts
 * SERVICE_UNAVAILABLE_CODES), so a 503 whose "code" is an exception's name is still a server error.
 * The shared catalog's 503 codes (integrations/shared/endpoint-catalog.json: server.unavailable,
 * server.busy, signing.not_set_up) plus the ones the Spring host's libraries throw with 503 that the
 * catalog does not list yet: the receiver's validator_unavailable, the kernel verdicts
 * pdf_unavailable and keys_unavailable (VerdictMapper), data_source.unavailable, and the TSA
 * client's timestamp.unavailable and timestamp.key, and the three codes of a failed run (wasm.execution_error,
 * outcome_too_large, definition.tooDeep). tests/host-check/http.test.ts holds this list to the catalog and to
 * the Java sources while the repository is there.
 */
export const TYPED_503_CODES: ReadonlySet<string> = new Set([
  "server.unavailable",
  "server.busy",
  "validator_unavailable",
  "pdf_unavailable",
  "keys_unavailable",
  "signing.not_set_up",
  "data_source.unavailable",
  "timestamp.unavailable",
  "timestamp.key",
  // A run that gave no verdict (the sandbox stopped it, its outcome passed the cap, or the registered form is nested
  // too deep to read): the receiving routes answer 503 with the run's code and no Retry-After, never a 422.
  "wasm.execution_error",
  "outcome_too_large",
  "definition.tooDeep"
]);
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const EXCERPT_CHARS = 300;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface SendOptions {
  /** The body's type, or none. */
  contentType?: string;
  body?: string | Uint8Array;
  /** Who sends it (default the visitor). */
  who?: Who;
  /** More headers for this request. */
  headers?: Record<string, string>;
  /**
   * Whether the route promises JSON (the second half of the never-5xx rule). Default: the URL's
   * path is under the API or WebAuthn path. A case that expects a PDF or DER on an API route says false.
   */
  jsonRoute?: boolean;
}

/** One request and what came back, for the report. */
export interface Exchange {
  label: string;
  method: string;
  path: string;
  who: Who;
  requestBytes: number;
  status: number;
  contentType: string;
  responseBytes: number;
  elapsedMs: number;
  excerpt: string;
  /** What broke the never-5xx rule (empty: clean). */
  problems: string[];
}

/** One answer of the host under test, as it came over the wire (the Java kit's Reply). */
export class Reply {
  private parsed: { ok: true; value: unknown } | { ok: false } | undefined;

  constructor(
    public readonly method: string,
    /** The request target as sent (path and query, raw). */
    public readonly path: string,
    public readonly status: number,
    /** Lower-case names, every value in order. */
    private readonly headerMap: ReadonlyMap<string, readonly string[]>,
    public readonly body: Uint8Array
  ) {}

  /** The body as UTF-8 text. */
  public text(): string {
    return new TextDecoder("utf-8", { fatal: false }).decode(this.body);
  }

  /** The body as Latin-1 text (a PDF, a DER file), byte for character. */
  public bytesAsText(): string {
    return Buffer.from(this.body).toString("latin1");
  }

  /** Whether the body parses as JSON. */
  public isJson(): boolean {
    return this.parse().ok;
  }

  /** The body as JSON; the case FAILs naming the status and text when it is not. */
  public json(): unknown {
    const parsed = this.parse();
    if (!parsed.ok) throw new CaseFailure(`Not JSON (${this.status}): ${clip(this.text())}`);
    return parsed.value;
  }

  /** The first value of a header, or undefined. */
  public header(name: string): string | undefined {
    return this.headerMap.get(name.toLowerCase())?.[0];
  }

  /** Every value of a header (Set-Cookie). */
  public headerValues(name: string): readonly string[] {
    return this.headerMap.get(name.toLowerCase()) ?? [];
  }

  public headerNames(): string[] {
    return [...this.headerMap.keys()];
  }

  /** The media type of the body without parameters, lower case (`application/json`), or "". */
  public mediaType(): string {
    const type = this.header("content-type") ?? "";
    const semicolon = type.indexOf(";");
    return (semicolon < 0 ? type : type.slice(0, semicolon)).trim().toLowerCase();
  }

  /** The code of the first error of a Datum error body (`{errors: [{code, message}]}`); the case FAILs when the body is not JSON. */
  public code(): string {
    return asString(path(this.json(), "errors", 0, "code"));
  }

  /** For messages: the request, the status and the start of the body. */
  public describe(): string {
    return `${this.method} ${this.path} -> ${this.status} ${this.excerpt()}`.trimEnd();
  }

  public excerpt(): string {
    const type = this.mediaType();
    if (this.body.length === 0) return "";
    if (type.startsWith("text/") || type.endsWith("json") || type === "" || type.endsWith("javascript")) return clip(this.text());
    return `<${this.body.length} bytes ${type}>`;
  }

  private parse(): { ok: true; value: unknown } | { ok: false } {
    if (this.parsed === undefined) {
      try {
        this.parsed = { ok: true, value: JSON.parse(this.text()) as unknown };
      } catch {
        this.parsed = { ok: false };
      }
    }
    return this.parsed;
  }
}

/** A persona's cookies: what the host set on that persona's replies, sent back on its later requests. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  /** Reads one Set-Cookie line: a name=value, removed again by Max-Age<=0 or an Expires in the past. */
  public take(setCookie: string, now = Date.now()): void {
    const [pair, ...attributes] = setCookie.split(";");
    const equals = (pair ?? "").indexOf("=");
    if (equals <= 0) return;
    const name = (pair as string).slice(0, equals).trim();
    const value = (pair as string).slice(equals + 1).trim();
    let expired = false;
    for (const attribute of attributes) {
      const [rawKey, ...rest] = attribute.split("=");
      const key = (rawKey ?? "").trim().toLowerCase();
      const attributeValue = rest.join("=").trim();
      if (key === "max-age" && /^-?\d+$/.test(attributeValue) && Number(attributeValue) <= 0) expired = true;
      if (key === "expires") {
        const at = Date.parse(attributeValue);
        if (!Number.isNaN(at) && at <= now) expired = true;
      }
    }
    if (expired) this.cookies.delete(name);
    else this.cookies.set(name, value);
  }

  public get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  /** The Cookie header value, or undefined when empty. */
  public header(): string | undefined {
    return this.cookies.size === 0 ? undefined : [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

/** What one raw request needs; the seam the tests replace. */
export interface RawRequest {
  method: string;
  url: string;
  headers: OutgoingHttpHeaders;
  body: Uint8Array | undefined;
  timeoutMs: number;
}

export interface RawResponse {
  status: number;
  headers: Map<string, string[]>;
  body: Uint8Array;
}

export interface HostHttpOptions {
  /** Called with every exchange (the runner keeps them per case). */
  onExchange?: (exchange: Exchange) => void;
}

/** Splits `scheme://authority/rest` without normalising anything in `rest`. */
export function splitUrl(url: string): { protocol: "http:" | "https:"; authority: string; hostname: string; port: number; requestTarget: string } {
  const match = /^(https?):\/\/([^/?#]+)([^#]*)$/i.exec(url);
  if (match === null) throw new CaseFailure(`not an http(s) URL: ${url}`);
  const protocol = (match[1] as string).toLowerCase() === "https" ? "https:" : "http:";
  const authority = match[2] as string;
  const ipv6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority);
  const plain = /^([^:]+)(?::(\d+))?$/.exec(authority);
  const hostname = ipv6 !== null ? (ipv6[1] as string) : plain !== null ? (plain[1] as string) : authority;
  const portText = ipv6 !== null ? ipv6[2] : plain?.[2];
  const port = portText !== undefined ? Number(portText) : protocol === "https:" ? 443 : 80;
  let requestTarget = match[3] as string;
  if (requestTarget === "") requestTarget = "/";
  else if (requestTarget.startsWith("?")) requestTarget = `/${requestTarget}`;
  return { protocol, authority, hostname, port, requestTarget };
}

/**
 * The HTTP client of one run. One instance per run: it holds the keep-alive agents and the cookie
 * jars of the three personas (VISITOR, PERSON, OTHER_PERSON).
 */
export class HostHttp {
  /** Set by the runner to the running case's id; every exchange carries it. */
  public label = "";
  public requestsSent = 0;
  private readonly httpAgent = new HttpAgent({ keepAlive: true });
  private readonly httpsAgent = new HttpsAgent({ keepAlive: true });
  private readonly jars = new Map<Who, CookieJar>();

  constructor(
    public readonly target: HostTarget,
    private readonly options: HostHttpOptions = {},
    /** Replaced in tests; the default speaks node:http / node:https. */
    private readonly transport: (request: RawRequest) => Promise<RawResponse> = (request) => this.nodeTransport(request)
  ) {}

  /** A GET of `url` (absolute, or a path under the base URL). */
  public get(url: string, who: Who = "visitor", headers: Record<string, string> = {}): Promise<Reply> {
    return this.send("GET", url, { who, headers });
  }

  /** A POST of a JSON text. */
  public postJson(url: string, json: string, who: Who = "visitor", headers: Record<string, string> = {}): Promise<Reply> {
    return this.send("POST", url, { contentType: "application/json", body: json, who, headers });
  }

  /** A POST of bytes with a content type (undefined: none). */
  public post(url: string, contentType: string | undefined, body: string | Uint8Array, who: Who = "visitor"): Promise<Reply> {
    return this.send("POST", url, { ...(contentType !== undefined ? { contentType } : {}), body, who });
  }

  /** Any request; the reply has passed the never-5xx rule (else the case FAILs here). */
  public async send(method: string, url: string, options: SendOptions = {}): Promise<Reply> {
    const who = options.who ?? "visitor";
    const absolute = this.absolute(url);
    const reply = await this.exchange(method, absolute, options, who, "case");
    return reply;
  }

  /** A request with no wire rule applied, for the preflight (a transport failure still throws TransportError). */
  public probe(method: string, url: string, options: SendOptions = {}): Promise<Reply> {
    return this.exchange(method, this.absolute(url), options, options.who ?? "visitor", "probe");
  }

  /** Closes the keep-alive connections, so the process can end. */
  public close(): void {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  /** A persona's jar (tests read it). */
  public jar(who: Who): CookieJar {
    let jar = this.jars.get(who);
    if (jar === undefined) {
      jar = new CookieJar();
      this.jars.set(who, jar);
    }
    return jar;
  }

  /**
   * The persona's CSRF token under the `--csrf` recipe: the one its jar holds, else the cookie a
   * `GET <endpoint>/` sets (the Java example ITs read the XSRF-TOKEN cookie the application hands any
   * visitor there). Undefined when no recipe is given or the host sets no such cookie.
   */
  public async csrfToken(who: Who = "visitor"): Promise<string | undefined> {
    const csrf = this.target.csrf;
    if (csrf === undefined) return undefined;
    const held = this.jar(who).get(csrf.cookie);
    if (held !== undefined) return held;
    await this.exchange("GET", `${this.target.baseUrl}/`, {}, who, "csrf");
    return this.jar(who).get(csrf.cookie);
  }

  /** Whether `url`'s path is under the API or the WebAuthn path of the target. */
  public isJsonRoute(url: string): boolean {
    const requestPath = splitUrl(this.absolute(url)).requestTarget.split("?")[0] as string;
    const basePath = splitUrl(this.target.baseUrl).requestTarget.replace(/\/$/, "");
    const under = (prefix: string): boolean => {
      const full = `${basePath}${prefix}`;
      return full !== "" && (requestPath === full || requestPath.startsWith(`${full}/`));
    };
    return under(this.target.apiPath) || under(this.target.webAuthnPath);
  }

  private absolute(url: string): string {
    return /^https?:\/\//i.test(url) ? url : `${this.target.baseUrl}${url}`;
  }

  private async exchange(method: string, url: string, options: SendOptions, who: Who, purpose: "case" | "probe" | "csrf"): Promise<Reply> {
    const judged = purpose === "case";
    const label = purpose === "csrf" ? `${this.label} (csrf token)` : this.label;
    const csrf = this.target.csrf;
    let csrfToken: string | undefined;
    if (csrf !== undefined && WRITE_METHODS.has(method.toUpperCase())) {
      csrfToken = await this.csrfToken(who);
      if (csrfToken === undefined) {
        // The csrf preflight probe makes a host that hands out no token INCONCLUSIVE before any case
        // runs; this is a host that stopped handing one out (or one a persona's headers keep from it).
        throw new CaseFailure(`no ${csrf.cookie} cookie on GET ${this.target.baseUrl}/ (as ${who}): the host hands out no CSRF token the --csrf recipe can echo`);
      }
    }
    const headers = this.headersFor(options, who, csrf !== undefined ? { name: csrf.header, token: csrfToken } : undefined);
    const body = options.body === undefined ? undefined : typeof options.body === "string" ? new TextEncoder().encode(options.body) : options.body;
    const { requestTarget } = splitUrl(url);
    const started = performance.now();
    this.requestsSent += 1;
    let response: RawResponse;
    try {
      response = await this.transport({ method, url, headers, body, timeoutMs: this.target.timeoutMs });
    } catch (error) {
      const failure = error instanceof TransportError ? error : new TransportError(`${method} ${url} failed: ${describeCause(error)}`, false);
      this.options.onExchange?.({
        label,
        method,
        path: requestTarget,
        who,
        requestBytes: body?.length ?? 0,
        status: 0,
        contentType: "",
        responseBytes: 0,
        elapsedMs: performance.now() - started,
        excerpt: failure.message,
        problems: []
      });
      throw failure;
    }
    if (csrf !== undefined) {
      for (const line of response.headers.get("set-cookie") ?? []) this.jar(who).take(line);
    }
    const reply = new Reply(method, requestTarget, response.status, response.headers, response.body);
    const jsonRoute = options.jsonRoute ?? this.isJsonRoute(url);
    const problems = judged ? wireProblems(reply, jsonRoute) : [];
    this.options.onExchange?.({
      label,
      method,
      path: requestTarget,
      who,
      requestBytes: body?.length ?? 0,
      status: reply.status,
      contentType: reply.header("content-type") ?? "",
      responseBytes: reply.body.length,
      elapsedMs: performance.now() - started,
      excerpt: reply.excerpt(),
      problems
    });
    if (problems.length > 0) {
      throw new CaseFailure(`never-5xx rule: ${problems.join("; ")} (${reply.describe()})`);
    }
    return reply;
  }

  /**
   * The headers in the Java kit's order: the content type, the target's headers, the request's own,
   * then the persona's (the RequestDecorator), then the CSRF header on a write. A name given twice
   * goes out twice, as HttpRequest.Builder.header adds; Cookie lines are joined with "; " and the
   * CSRF token cookie comes last. Only that one cookie goes out from the jar, whatever else the host
   * set (a page's JSESSIONID, a passkey flow's session): the Java decorators send exactly
   * `Cookie: XSRF-TOKEN=<token>`, and a session cookie the oracle never sends can change an answer
   * (the TSA refuses any session-named cookie with 403 first, TsaEndpoint).
   */
  private headersFor(options: SendOptions, who: Who, csrf: { name: string; token: string | undefined } | undefined): OutgoingHttpHeaders {
    const lines: [string, string][] = [];
    if (options.contentType !== undefined) lines.push(["Content-Type", options.contentType]);
    for (const entry of Object.entries(this.target.headers)) lines.push(entry);
    for (const entry of Object.entries(options.headers ?? {})) lines.push(entry);
    const persona = who === "person" ? this.target.personHeaders : who === "other-person" ? this.target.otherPersonHeaders : {};
    for (const entry of Object.entries(persona)) lines.push(entry);
    if (csrf?.token !== undefined) lines.push([csrf.name, csrf.token]);
    const recipe = this.target.csrf;
    const token = recipe !== undefined ? this.jar(who).get(recipe.cookie) : undefined;
    const jarCookies = recipe !== undefined && token !== undefined ? `${recipe.cookie}=${token}` : undefined;
    const out: Record<string, string | string[]> = {};
    const names = new Map<string, string>();
    const cookies: string[] = [];
    for (const [name, value] of lines) {
      if (name.toLowerCase() === "cookie") {
        cookies.push(value);
        continue;
      }
      const key = names.get(name.toLowerCase()) ?? name;
      names.set(name.toLowerCase(), key);
      const previous = out[key];
      out[key] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value];
    }
    if (jarCookies !== undefined) cookies.push(jarCookies);
    if (cookies.length > 0) out["Cookie"] = cookies.join("; ");
    if (!Object.keys(out).some((name) => name.toLowerCase() === "user-agent")) out["User-Agent"] = `datum-host-check/${KIT_VERSION}`;
    return out;
  }

  private nodeTransport(request: RawRequest): Promise<RawResponse> {
    const { protocol, hostname, port, requestTarget } = splitUrl(request.url);
    const headers: OutgoingHttpHeaders = { ...request.headers };
    if (request.body !== undefined) headers["Content-Length"] = String(request.body.length);
    else if (!["GET", "HEAD", "DELETE", "OPTIONS", "TRACE"].includes(request.method.toUpperCase())) headers["Content-Length"] = "0";
    return new Promise<RawResponse>((resolve, reject) => {
      let settled = false;
      const finish = (outcome: { ok: true; value: RawResponse } | { ok: false; error: Error }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (outcome.ok) resolve(outcome.value);
        else reject(outcome.error);
      };
      const send = protocol === "https:" ? httpsRequest : httpRequest;
      const req = send({
        protocol,
        hostname,
        port,
        path: requestTarget,
        method: request.method,
        headers,
        agent: protocol === "https:" ? this.httpsAgent : this.httpAgent
      });
      const timer = setTimeout(() => {
        req.destroy();
        finish({ ok: false, error: new TransportError(`${request.method} ${request.url}: no answer within ${request.timeoutMs} ms`, true) });
      }, request.timeoutMs);
      let answered = false;
      req.on("response", (response: IncomingMessage) => {
        answered = true;
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            response.destroy();
            req.destroy();
            finish({ ok: false, error: new TransportError(`${request.method} ${request.url}: the answer is over ${MAX_RESPONSE_BYTES} bytes`, false) });
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const map = new Map<string, string[]>();
          const raw = response.rawHeaders;
          for (let at = 0; at + 1 < raw.length; at += 2) {
            const name = (raw[at] as string).toLowerCase();
            const values = map.get(name) ?? [];
            values.push(raw[at + 1] as string);
            map.set(name, values);
          }
          finish({ ok: true, value: { status: response.statusCode ?? 0, headers: map, body: new Uint8Array(Buffer.concat(chunks)) } });
        });
        response.on("error", (error) => finish({ ok: false, error: new TransportError(`${request.method} ${request.url}: the answer was cut off: ${describeCause(error)}`, false) }));
      });
      req.on("error", (error) => {
        // A server may answer (413) and close before it read the whole body: the answer counts, the write error does not.
        if (answered) return;
        finish({ ok: false, error: new TransportError(`${request.method} ${request.url} failed: ${describeCause(error)}`, false) });
      });
      if (request.body !== undefined) req.end(Buffer.from(request.body));
      else req.end();
    });
  }
}

/** The never-5xx rule over one reply; a list of problems (empty: clean). */
export function wireProblems(reply: Reply, jsonRoute: boolean): string[] {
  const problems: string[] = [];
  const where = `${reply.method} ${reply.path} -> ${reply.status}`;
  if (reply.status >= 500) {
    const code = reply.isJson() ? path(reply.json(), "errors", 0, "code") : undefined;
    if (!(reply.status === 503 && typeof code === "string" && TYPED_503_CODES.has(code))) {
      problems.push(`${where}: a server error that is not a typed 503`);
    }
  }
  if (jsonRoute && reply.method.toUpperCase() !== "HEAD") {
    const emptyOk = (reply.status === 204 || reply.status === 304) && reply.body.length === 0;
    if (!emptyOk && !NON_JSON_TOLERATED.has(reply.status) && !reply.isJson()) {
      problems.push(`${where}: the body is not JSON`);
    }
  }
  return problems;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}...` : flat;
}

function describeCause(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code !== undefined && !message.includes(code) ? `${code} ${message}` : message;
}
