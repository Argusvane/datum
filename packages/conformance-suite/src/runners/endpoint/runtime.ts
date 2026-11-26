import { createHash } from "node:crypto";

import { referenceDigest } from "../../reference/canonical.js";
import type { Json, Observation } from "../../observation.js";
import { HttpClient, TransportError, routesFor, type EndpointTarget, type HttpRequestSpec, type HttpResponse } from "./http.js";
import { profileFor, type CheckParts, type Profile } from "./profiles/index.js";
import type { EndpointRow, RequestSpec, RowContext } from "./rows.js";
import { observe } from "./wire.js";

/** Everything a row needs to put requests on the wire. */
export interface Runtime {
  target: EndpointTarget;
  profile: Profile;
  client: HttpClient;
  bodyLimit: number;
  /** The public definition's URL for this profile (the operator's, else the submissions route). */
  definitionUrl: string | undefined;
}

export function rowContext(runtime: Runtime): RowContext {
  return {
    bodyLimit: runtime.bodyLimit,
    profile: runtime.target.profile,
    checkBody: (parts: CheckParts = {}) => runtime.profile.checkBody(runtime.target, parts),
    submitBody: (parts: CheckParts = {}, deliver) => runtime.profile.submitBody(runtime.target, parts, deliver)
  };
}

export function definitionUrlOf(target: EndpointTarget): string | undefined {
  return target.publicDefinitionUrl ?? routesFor(target).definition;
}

export function createRuntime(target: EndpointTarget, client: HttpClient, bodyLimit: number): Runtime {
  return { target, profile: profileFor(target.profile), client, bodyLimit, definitionUrl: definitionUrlOf(target) };
}

/** What one request did: the observation, and the bytes it carried for the report's evidence. */
export interface Sent {
  observation: Observation;
  response: HttpResponse | undefined;
  requestBody: string | Uint8Array | undefined;
  /**
   * The HTTP exchange, from the open connection to the answer's last byte. On a timeout it is the
   * wait until the suite gave up (so the time bound sees a hang); 0 when nothing was sent.
   */
  elapsedMs: number;
  /** From the open connection to the answer's first byte; on a timeout with no answer, the whole wait. */
  firstByteMs: number;
  /** DNS and TCP connect before the exchange (null: not known, or nothing was sent). */
  connectMs: number | null;
  /** False when no request went out (no URL to send to, or the connection never opened). */
  sent: boolean;
}

const JSON_TYPE = "application/json";

/** Builds the HTTP request of one spec. Returns undefined when the spec cannot be sent in this setup (no definition URL). */
export function buildRequest(runtime: Runtime, spec: RequestSpec, label: string): HttpRequestSpec | undefined {
  const routes = routesFor(runtime.target);
  const context = rowContext(runtime);
  switch (spec.kind) {
    case "check":
      return { method: "POST", url: routes.validate, headers: { "content-type": JSON_TYPE }, body: runtime.profile.checkBody(runtime.target, spec), label };
    case "submit":
      return { method: "POST", url: routes.submit, headers: { "content-type": JSON_TYPE }, body: runtime.profile.submitBody(runtime.target, spec), label };
    case "raw": {
      const method = spec.method ?? "POST";
      const url = spec.route === "validate" ? routes.validate : routes.submit;
      const headers: Record<string, string> = {};
      if (spec.contentType !== null) {
        headers["content-type"] = spec.contentType ?? JSON_TYPE;
      }
      const body = typeof spec.body === "function" ? spec.body(context) : spec.body;
      return { method, url, headers, ...(method === "POST" && body !== undefined ? { body } : {}), label };
    }
    case "get":
      return runtime.definitionUrl === undefined ? undefined : { method: "GET", url: runtime.definitionUrl, label: `definition ${label}` };
  }
}

/** Sends one request spec and observes the answer. Transport timeouts are an observation (a hang is a FAIL); other transport errors throw. */
export async function sendSpec(runtime: Runtime, spec: RequestSpec, label: string): Promise<Sent> {
  const request = buildRequest(runtime, spec, label);
  if (request === undefined) {
    return { observation: { kind: "refusal", refusal: "other", code: "unavailable", detail: "no public definition URL" }, response: undefined, requestBody: undefined, elapsedMs: 0, firstByteMs: 0, connectMs: null, sent: false };
  }
  try {
    const response = await runtime.client.send(request);
    const observation = spec.kind === "get" ? answerOf(response) : observe(response);
    return { observation, response, requestBody: request.body, elapsedMs: response.elapsedMs, firstByteMs: response.timing.firstByteMs, connectMs: response.timing.connectMs, sent: true };
  } catch (error) {
    if (error instanceof TransportError && error.timedOut) {
      return { observation: { kind: "refusal", refusal: "budget", code: "timeout", detail: error.message }, response: undefined, requestBody: request.body, elapsedMs: error.waited.ms, firstByteMs: error.waited.ms, connectMs: error.waited.connectMs, sent: error.waited.sent };
    }
    throw error;
  }
}

function answerOf(response: HttpResponse): Observation {
  return { kind: "answer", json: { status: response.status, body: response.jsonOk ? (response.json as Json) : response.text.slice(0, 2000) } };
}

export function sha256(body: string | Uint8Array | undefined): string | undefined {
  return body === undefined ? undefined : createHash("sha256").update(body).digest("hex");
}

export function byteLength(body: string | Uint8Array | undefined): number {
  return body === undefined ? 0 : typeof body === "string" ? Buffer.byteLength(body) : body.length;
}

/** The document the suite delivered, parsed back from the last request body (the profile's wire says where it sits). */
export function sentDocument(runtime: Runtime, body: string | Uint8Array | undefined): unknown {
  if (typeof body !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    if (runtime.target.profile === "submissions" && parsed !== null && typeof parsed === "object" && "document" in parsed) {
      return (parsed as { document: unknown }).document;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function goldenSent(document: unknown): { name: string; canonical: string; digest: string } {
  const { canonical, digest } = referenceDigest(document);
  return { name: "sent", canonical, digest };
}

export type { EndpointRow };
