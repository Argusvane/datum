import { Budget, parseRetryAfter } from "./budget.js";
import { TransportFailure, exchangeOverHttp, type ExchangeTiming } from "./transport.js";
import { SUITE_VERSION } from "../../version.js";

export type ProfileName = "submissions";

/** What an endpoint run talks to. */
export interface EndpointTarget {
  /** `https://host` or `https://host/prefix`, no trailing slash needed. Credentials in the URL are refused. */
  baseUrl: string;
  profile: ProfileName;
  formId: string;
  formVersion: string;
  allowWrites: boolean;
  /** A GET the operator names: the form's public definition (SEC-02, the fixture marker). */
  publicDefinitionUrl?: string;
}

/** A form id no real form has; the one other form id a request may name (REC-10, the unknown-form probe). */
export const UNKNOWN_FORM_ID = "datum-security-suite--no-such-form";

/** `@argusvane/datum-submissions`' catalog key (`catalogKeyOf`), spelled here so the bundle needs no dependency on it. */
export function catalogKey(formId: string, formVersion: string): string {
  return `${formId.replace(/%/g, "%25").replace(/@/g, "%40")}@${formVersion}`;
}

export interface Routes {
  validate: string;
  submit: string;
  /** The form's own public definition and record list. */
  definition?: string;
  submissions?: string;
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** The absolute URLs of a profile's routes for one form. */
export function routesFor(target: EndpointTarget): Routes {
  const base = trimBase(target.baseUrl);
  const key = encodeURIComponent(catalogKey(target.formId, target.formVersion));
  return {
    validate: `${base}/api/submissions/validate`,
    submit: `${base}/api/submissions`,
    definition: `${base}/api/forms/${key}/definition`,
    submissions: `${base}/api/forms/${key}/submissions`
  };
}

/** Anything the suite is not allowed to send: a bug in the suite, never a finding about the server. */
export class AllowlistViolation extends Error {
  constructor(message: string) {
    super(`allowlist: ${message}`);
    this.name = "AllowlistViolation";
  }
}

/** A request that never produced an HTTP answer (refused, reset, timed out). */
export class TransportError extends Error {
  constructor(
    message: string,
    public readonly timedOut: boolean,
    /**
     * How long the exchange ran before it failed (timed like a response's `timing.totalMs`), and
     * whether the request went out at all (false: the connection never opened).
     */
    public readonly waited: { sent: boolean; ms: number; connectMs: number | null } = { sent: false, ms: 0, connectMs: null }
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export interface HttpRequestSpec {
  /** PUT and DELETE are for a client built with `allow` (the builder profile); the default allowlist refuses them. */
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Which vector row asked, for the exchange log. */
  label?: string;
  /** Send none of the operator's headers (cookie, auth): the request an anonymous visitor makes. */
  anonymous?: boolean;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  bytes: number;
  truncated: boolean;
  json: unknown;
  jsonOk: boolean;
  /** The exchange itself (= `timing.totalMs`): from the open connection to the last byte of the answer. */
  elapsedMs: number;
  timing: ExchangeTiming;
}

/** One request and what came back, kept for the derived rows and the report's evidence. */
export interface Exchange {
  label: string;
  method: string;
  path: string;
  requestBytes: number;
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
  json: unknown;
  jsonOk: boolean;
  elapsedMs: number;
  /** Time to the first byte of the answer, from the open connection. */
  firstByteMs: number;
  /** DNS and TCP connect before the exchange; null when the transport cannot tell (a replaced fetch). */
  connectMs: number | null;
}

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const KEPT_TEXT_CHARS = 256 * 1024;

export interface HttpClientOptions {
  target: EndpointTarget;
  /**
   * Replaces the default allowlist (the profile's routes for one form): true when the request may
   * be sent. The builder profile uses it because its routes carry a form id the run creates.
   * The credentials-in-URL, no-redirect and budget rules still apply.
   */
  allow?: (method: string, url: URL) => boolean;
  budget: Budget;
  timeoutMs: number;
  /** Header lines the operator passed (`Name: value`); values are never reported. */
  headers: Record<string, string>;
  /**
   * Replaces the transport (tests). Unset, every request goes out on a connection of its own
   * ({@link exchangeOverHttp}), never through the global fetch: see transport.ts for the
   * keep-alive stall that rules undici out.
   */
  fetchImpl?: typeof fetch;
}

/**
 * The only way the suite talks to a server. Every request passes {@link assertAllowed} first:
 * a GET or a POST to one of the profile's routes for THIS form (plus the operator's two named
 * GET URLs). It never sends PUT or DELETE, never follows a redirect, never names another form
 * (but the one synthetic unknown id), and counts against the budget.
 */
export class HttpClient {
  public readonly exchanges: Exchange[] = [];
  private readonly allowed: { method: string; url: string }[];
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(private readonly options: HttpClientOptions) {
    const { target } = options;
    if (/\/\/[^/]*@/.test(target.baseUrl)) {
      throw new AllowlistViolation("credentials in the endpoint URL are not accepted; pass --auth-header or --cookie");
    }
    this.fetchImpl = options.fetchImpl;
    if (options.allow !== undefined) {
      this.allowed = [];
      return;
    }
    const routes = routesFor(target);
    const allowed: { method: string; url: string }[] = [{ method: "POST", url: routes.validate }];
    if (target.allowWrites) {
      allowed.push({ method: "POST", url: routes.submit });
    }
    // A GET of the validate route is the "method not allowed" probe (REC-10): it reads nothing and writes nothing.
    allowed.push({ method: "GET", url: routes.validate });
    allowed.push({ method: "GET", url: routes.definition as string });
    allowed.push({ method: "GET", url: routes.submissions as string });
    if (target.publicDefinitionUrl !== undefined) {
      allowed.push({ method: "GET", url: target.publicDefinitionUrl });
    }
    this.allowed = allowed.map((entry) => ({ method: entry.method, url: new URL(entry.url).href }));
  }

  /** Throws unless the request is one the suite may send. Exposed for tests. */
  public assertAllowed(method: string, url: string): void {
    if (this.options.allow === undefined && method !== "GET" && method !== "POST") {
      throw new AllowlistViolation(`${method} is never sent`);
    }
    let href: string;
    let parsed: URL;
    try {
      parsed = new URL(url);
      if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
        throw new Error("credentials or a fragment");
      }
      href = parsed.href;
    } catch {
      throw new AllowlistViolation(`${url} is not a plain URL`);
    }
    if (this.options.allow !== undefined) {
      if (!["GET", "POST", "PUT", "DELETE"].includes(method) || !this.options.allow(method, parsed)) {
        throw new AllowlistViolation(`${method} ${parsed.pathname}${parsed.search} is not a request this run may send`);
      }
      return;
    }
    if (!this.allowed.some((entry) => entry.method === method && entry.url === href)) {
      throw new AllowlistViolation(`${method} ${href} is not one of the routes of form "${this.options.target.formId}"`);
    }
  }

  public get budget(): Budget {
    return this.options.budget;
  }

  public async send(spec: HttpRequestSpec): Promise<HttpResponse> {
    this.assertAllowed(spec.method, spec.url);
    for (let attempt = 0; ; attempt += 1) {
      await this.options.budget.take();
      const response = await this.once(spec);
      this.record(spec, response);
      if (response.status !== 429) {
        return response;
      }
      // A 429 is waited out once when the server says it is short; otherwise the run stops (never a retry storm).
      await this.options.budget.onTooManyRequests(parseRetryAfter(response.headers["retry-after"]), response.status);
      if (attempt >= 1) {
        return response;
      }
    }
  }

  private async once(spec: HttpRequestSpec): Promise<HttpResponse> {
    const headers: Record<string, string> = { accept: "application/json", ...(spec.anonymous === true ? {} : this.options.headers), ...(spec.headers ?? {}) };
    if (this.fetchImpl === undefined && !Object.keys(headers).some((name) => name.toLowerCase() === "user-agent")) {
      // node:http sends none (fetch sent "node"); a firewall in front of a site may refuse a request without one.
      headers["user-agent"] = `datum-security-check/${SUITE_VERSION}`;
    }
    const { status, headers: headerMap, bytes, truncated, timing } = this.fetchImpl === undefined ? await this.overHttp(spec, headers) : await this.overFetch(this.fetchImpl, spec, headers);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    let json: unknown;
    let jsonOk = false;
    if (!truncated) {
      try {
        json = JSON.parse(text);
        jsonOk = true;
      } catch {
        jsonOk = false;
      }
    }
    return { status, headers: headerMap, text, bytes: bytes.length, truncated, json, jsonOk, elapsedMs: timing.totalMs, timing };
  }

  /** The default transport: one connection per request, timed from the open connection. */
  private async overHttp(spec: HttpRequestSpec, headers: Record<string, string>): Promise<RawAnswer> {
    try {
      return await exchangeOverHttp({
        method: spec.method,
        url: spec.url,
        headers,
        ...(spec.body !== undefined ? { body: spec.body } : {}),
        timeoutMs: this.options.timeoutMs,
        maxResponseBytes: MAX_RESPONSE_BYTES
      });
    } catch (error) {
      if (error instanceof TransportFailure) {
        if (error.timedOut) {
          throw new TransportError(`no answer within ${this.options.timeoutMs} ms`, true, error.waited);
        }
        throw new TransportError(error.phase === "response" ? `the answer was cut off: ${error.message}` : `cannot reach the server: ${error.message}`, false, error.waited);
      }
      throw error;
    }
  }

  /** A replaced transport (tests): the fetch call to its resolution is the first byte, the body read the last. */
  private async overFetch(fetchImpl: typeof fetch, spec: HttpRequestSpec, headers: Record<string, string>): Promise<RawAnswer> {
    const started = performance.now();
    let response: Response;
    try {
      response = await fetchImpl(spec.url, {
        method: spec.method,
        headers,
        ...(spec.body !== undefined ? { body: spec.body as BodyInit } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(this.options.timeoutMs)
      });
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      const timedOut = name === "TimeoutError" || name === "AbortError";
      throw new TransportError(timedOut ? `no answer within ${this.options.timeoutMs} ms` : `cannot reach the server: ${describeCause(error)}`, timedOut, { sent: timedOut, ms: performance.now() - started, connectMs: null });
    }
    const firstByteMs = performance.now() - started;
    let bytes: Uint8Array;
    let truncated = false;
    try {
      ({ bytes, truncated } = await readBounded(response));
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      throw new TransportError(`the answer was cut off: ${describeCause(error)}`, name === "TimeoutError" || name === "AbortError", { sent: true, ms: performance.now() - started, connectMs: null });
    }
    const headerMap: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headerMap[name.toLowerCase()] = value;
    });
    return { status: response.status, headers: headerMap, bytes, truncated, timing: { connectMs: null, firstByteMs, totalMs: performance.now() - started } };
  }

  private record(spec: HttpRequestSpec, response: HttpResponse): void {
    const url = new URL(spec.url);
    this.exchanges.push({
      label: spec.label ?? "",
      method: spec.method,
      path: url.pathname,
      requestBytes: typeof spec.body === "string" ? Buffer.byteLength(spec.body) : (spec.body?.length ?? 0),
      status: response.status,
      contentType: response.headers["content-type"] ?? "",
      text: response.text.length > KEPT_TEXT_CHARS ? response.text.slice(0, KEPT_TEXT_CHARS) : response.text,
      truncated: response.truncated,
      json: response.json,
      jsonOk: response.jsonOk,
      elapsedMs: response.elapsedMs,
      firstByteMs: response.timing.firstByteMs,
      connectMs: response.timing.connectMs
    });
  }
}

interface RawAnswer {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array;
  truncated: boolean;
  timing: ExchangeTiming;
}

function describeCause(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } } | null)?.cause;
  if (cause?.code !== undefined) {
    return cause.code;
  }
  return error instanceof Error ? error.message : String(error);
}

async function readBounded(response: Response): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (response.body === null) {
    return { bytes: new Uint8Array(0), truncated: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (total + value.length > MAX_RESPONSE_BYTES) {
      chunks.push(value.subarray(0, MAX_RESPONSE_BYTES - total));
      total = MAX_RESPONSE_BYTES;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { bytes, truncated };
}
