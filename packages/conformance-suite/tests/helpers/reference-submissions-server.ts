import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { FormDefinition } from "@argusvane/datum-engine";
import {
  InMemorySubmissionStore,
  catalogKeyOf,
  createKernelValidator,
  createSubmissionService,
  errorResponse,
  parseStrictJson,
  receiveResponse,
  validationBody,
  type SubmissionService,
  type SubmissionValidator
} from "@argusvane/datum-submissions";

import { BASE_DEFINITION } from "../../src/fixtures/base-form.js";
import { checkRequestOf } from "./contract-wire.js";

/**
 * The reference server for the endpoint self-tests: the real `@argusvane/datum-submissions` service (the
 * kernel validator, an in-memory store) behind `node:http`, answering with the package's own
 * helpers (`parseValidateRequest`, `validationBody`, `receiveResponse`, `errorResponse`). It is a GOOD server: the submissions-profile
 * vectors must all pass against it. The HTTP layer does what a host must do before the service
 * sees a body (a body cap, strict UTF-8, JSON with no repeated key, a finite number, an object), because the service
 * takes already-parsed input. The package's answers are the hosts' contract as it stands: a check is strict
 * about its request and answers `{accepted, errors, notes?}`, and a run that failed is a 503 with its code.
 */
export interface ReferenceServerOptions {
  /** The body cap in bytes (default 1 MiB, the suite's `--body-limit` default). `null`: none. */
  bodyLimit?: number | null;
  /** Also register an older version ("0") of the fixture first, so the other-version vector meets `version_superseded`. */
  olderVersion?: boolean;
  /** The validator behind the service (default: the kernel); a negative server passes a broken one. */
  validator?: SubmissionValidator;
  /** A fault injected into the server (the negative servers build on this). */
  fault?: (request: ParsedRequest) => FaultAnswer | undefined;
  /** Replaces the form registered (default: the fixture). */
  definition?: FormDefinition;
}

export interface FaultAnswer {
  /** Never answer (a hang). */
  hang?: boolean;
  status: number;
  contentType?: string;
  body: string;
}

export interface ParsedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  bodyText: string;
  json: unknown;
  jsonOk: boolean;
}

export interface ReferenceServer {
  url: string;
  service: SubmissionService;
  /** Every request the server saw, in order. */
  seen: { method: string; path: string; bytes: number }[];
  key: string;
  close(): Promise<void>;
}

const FIXTURE_ID = BASE_DEFINITION.id;

export async function startReferenceServer(options: ReferenceServerOptions = {}): Promise<ReferenceServer> {
  const store = new InMemorySubmissionStore();
  const service = createSubmissionService({ store, validator: options.validator ?? createKernelValidator() });
  if (options.olderVersion === true) {
    await service.register({ ...(BASE_DEFINITION as unknown as FormDefinition), version: "0" });
  }
  await service.register((options.definition ?? BASE_DEFINITION) as unknown as FormDefinition);
  const definition = (options.definition ?? BASE_DEFINITION) as unknown as FormDefinition;
  const key = catalogKeyOf(definition.id, definition.version);
  const limit = options.bodyLimit === undefined ? 1_048_576 : options.bodyLimit;
  const seen: ReferenceServer["seen"] = [];

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        send(response, 500, { errors: [{ code: "server.error" }] });
      }
      void error;
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      if (limit !== null && total > limit) {
        tooLarge = true;
        continue;
      }
      chunks.push(buffer);
    }
    seen.push({ method, path, bytes: total });
    if (tooLarge) {
      send(response, 413, { errors: [{ code: "bad_document" }] });
      return;
    }
    const raw = Buffer.concat(chunks);
    let bodyText = "";
    let utf8 = true;
    try {
      bodyText = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      utf8 = false;
    }
    let json: unknown;
    let jsonOk = false;
    if (utf8) {
      try {
        json = parseStrictJson(bodyText);
        jsonOk = true;
      } catch {
        jsonOk = false;
      }
    }
    const parsed: ParsedRequest = { method, path, headers: request.headers, bodyText, json, jsonOk };
    const fault = options.fault?.(parsed);
    if (fault?.hang === true) {
      return;
    }
    if (fault !== undefined) {
      response.statusCode = fault.status;
      response.setHeader("content-type", fault.contentType ?? "text/html; charset=utf-8");
      response.end(fault.body);
      return;
    }

    if (path === "/api/submissions/validate" || path === "/api/submissions") {
      if (method !== "POST") {
        response.setHeader("allow", "POST");
        send(response, 405, { errors: [{ code: "method_not_allowed" }] });
        return;
      }
      if (!utf8 || !jsonOk || hasNonFiniteNumber(json) || !isInput(json)) {
        send(response, 400, { errors: [{ code: "bad_document" }] });
        return;
      }
      try {
        if (path === "/api/submissions/validate") {
          send(response, 200, validationBody(await service.validate(checkRequestOf(json, total))));
          return;
        }
        const answer = receiveResponse(await service.receive(json as never));
        send(response, answer.status, answer.body);
      } catch (error) {
        const refusal = errorResponse(error);
        if (refusal !== undefined) {
          send(response, refusal.status, refusal.body);
          return;
        }
        send(response, 500, { errors: [{ code: "server.error" }] });
      }
      return;
    }
    if (method === "GET" && path === `/api/forms/${encodeURIComponent(key)}/definition`) {
      send(response, 200, await service.publicDefinition(key));
      return;
    }
    if (method === "GET" && path === `/api/forms/${encodeURIComponent(key)}/submissions`) {
      send(response, 200, await service.listRecords({ filter: { formKey: key }, limit: 1 }));
      return;
    }
    send(response, 404, { errors: [{ code: "not_found" }] });
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    service,
    seen,
    key,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

/** What the service takes: `{document: {...}}`, or the bare `{formId, formVersion, values}` form. Anything else is the host's 400. */
function isInput(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const object = (inner: unknown): boolean => inner !== null && typeof inner === "object" && !Array.isArray(inner);
  return "document" in record ? object(record["document"]) : typeof record["formId"] === "string" && typeof record["formVersion"] === "string" && object(record["values"]);
}

function hasNonFiniteNumber(value: unknown): boolean {
  if (typeof value === "number") {
    return !Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.some(hasNonFiniteNumber);
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(hasNonFiniteNumber);
  }
  return false;
}

export { FIXTURE_ID };
