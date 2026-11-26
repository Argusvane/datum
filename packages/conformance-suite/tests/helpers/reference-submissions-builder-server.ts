import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { FormDefinition } from "@argusvane/datum-engine";
import {
  InMemorySubmissionStore,
  SubmissionServiceError,
  createKernelValidator,
  createSubmissionService,
  errorResponse,
  receiveResponse,
  statusOf,
  validationBody,
  type SubmissionService
} from "@argusvane/datum-submissions";

import { checkRequestOf } from "./contract-wire.js";

/**
 * The reference server for the builder profile's `submissions` host: the real `@argusvane/datum-submissions`
 * service behind `node:http`, with the routes the profile uses (`POST /api/forms`,
 * `GET /api/forms/:key/definition`, `GET /api/forms/:key/inspect?op=`, `DELETE /api/forms/:key`,
 * the two submission routes). The HTTP layer does what a host must do before the service sees a
 * body (a body cap, strict UTF-8, JSON, a finite number, a definition-shaped object, the depth
 * limits), because the service takes already-parsed input. The two submission routes answer with the package's helpers
 * (the hosts' contract); a save's own refusals stay the 422 they are.
 */
export interface ReferenceBuilderOptions {
  /** The body cap in bytes (default 8 MiB). */
  maxBody?: number;
  fault?: {
    /** Registers whatever arrives, however deep (no depth guard): a 3000-deep definition may blow the stack. */
    noDepthGuard?: boolean;
    /** The public definition route serves the stored definition whole. */
    leakSecretsInPublic?: boolean;
    /** Delete does nothing. */
    deleteDoesNothing?: boolean;
    /** Registration answers 500 for a body that is not an object (an unguarded host). */
    crashOnNonObject?: boolean;
  };
}

export interface ReferenceBuilderServer {
  url: string;
  service: SubmissionService;
  seen: { method: string; path: string; search: string; bytes: number }[];
  close(): Promise<void>;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export async function startReferenceBuilderServer(options: ReferenceBuilderOptions = {}): Promise<ReferenceBuilderServer> {
  const store = new InMemorySubmissionStore();
  const service = createSubmissionService({ store, validator: createKernelValidator() });
  const limit = options.maxBody ?? 8 * 1024 * 1024;
  const fault = options.fault ?? {};
  const seen: ReferenceBuilderServer["seen"] = [];

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        send(response, 500, { errors: [{ code: "server.error" }], detail: String(error) });
      }
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    for await (const chunk of request) {
      total += (chunk as Buffer).length;
      if (total > limit) {
        tooLarge = true;
        continue;
      }
      chunks.push(chunk as Buffer);
    }
    seen.push({ method, path: url.pathname, search: url.search, bytes: total });
    if (tooLarge) {
      return send(response, 413, { errors: [{ code: "bad_document" }] });
    }
    const raw = Buffer.concat(chunks);
    const parse = (): { ok: true; json: unknown } | { ok: false } => {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
      } catch {
        return { ok: false };
      }
      if (nesting(text) > 256) {
        return { ok: false };
      }
      try {
        const json = JSON.parse(text) as unknown;
        return nonFinite(json) ? { ok: false } : { ok: true, json };
      } catch {
        return { ok: false };
      }
    };

    if (url.pathname === "/api/forms" && method === "POST") {
      const body = parse();
      if (!body.ok) {
        return send(response, 400, { errors: [{ code: "bad_document" }] });
      }
      const definition = body.json;
      if (!record(definition)) {
        if (fault.crashOnNonObject === true) {
          return send(response, 500, { errors: [{ code: "server.error" }], detail: "TypeError: Cannot read properties of null" });
        }
        return send(response, 422, { code: "invalid_definition", message: "A form definition is a JSON object." });
      }
      const shape = shapeProblem(definition, fault.noDepthGuard !== true);
      if (shape !== undefined) {
        return send(response, 422, { code: "invalid_definition", message: shape });
      }
      try {
        const entry = await service.register(definition as unknown as FormDefinition);
        const structureWarnings = (entry as { structureWarnings?: { code: string; where: string }[] }).structureWarnings;
        return send(response, 201, {
          key: entry.key,
          ...(entry.formulaProblems !== undefined ? { formulaProblems: entry.formulaProblems.map((problem) => ({ where: problem.where, code: problem.code })) } : {}),
          structureWarnings: (structureWarnings ?? []).map((problem) => ({ code: problem.code, where: problem.where }))
        });
      } catch (error) {
        if (error instanceof SubmissionServiceError) {
          return send(response, statusOf(error), { code: error.code, message: error.message.replace(/matches\(.*$/, "") });
        }
        throw error;
      }
    }
    const form = /^\/api\/forms\/([^/]+)(\/definition|\/inspect)?$/.exec(url.pathname);
    if (form !== null) {
      const key = decodeURIComponent(form[1] as string);
      try {
        if (form[2] === "/definition" && method === "GET") {
          if (fault.leakSecretsInPublic === true) {
            return send(response, 200, (await store.getCatalogEntry(key))?.definition ?? null);
          }
          return send(response, 200, await service.publicDefinition(key));
        }
        if (form[2] === "/inspect" && method === "GET") {
          const op = url.searchParams.get("op");
          if (op !== "public" && op !== "check" && op !== "inspect") {
            return send(response, 400, { errors: [{ code: "bad_document" }] });
          }
          return send(response, 200, await service.inspect(key, op));
        }
        if (form[2] === undefined && method === "DELETE") {
          if (fault.deleteDoesNothing !== true) {
            await service.deleteEntry(key, { cascade: url.searchParams.get("cascade") === "true" });
          }
          response.statusCode = 204;
          response.end();
          return;
        }
      } catch (error) {
        if (error instanceof SubmissionServiceError) {
          return send(response, statusOf(error), { errors: [{ code: error.code }] });
        }
        throw error;
      }
    }
    if ((url.pathname === "/api/submissions/validate" || url.pathname === "/api/submissions") && method === "POST") {
      const body = parse();
      if (!body.ok || !record(body.json) || !record(body.json["document"])) {
        return send(response, 400, { errors: [{ code: "bad_document" }] });
      }
      try {
        if (url.pathname.endsWith("/validate")) {
          return send(response, 200, validationBody(await service.validate(checkRequestOf(body.json, total))));
        }
        const answer = receiveResponse(await service.receive(body.json as never));
        return send(response, answer.status, answer.body);
      } catch (error) {
        const refusal = errorResponse(error);
        if (refusal !== undefined) {
          return send(response, refusal.status, refusal.body);
        }
        throw error;
      }
    }
    send(response, 404, { errors: [{ code: "not_found" }] });
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    service,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

/** The definition-shaped checks a host makes before it calls `register` (the service takes parsed input). */
function shapeProblem(definition: Record<string, unknown>, guardDepth: boolean): string | undefined {
  for (const key of ["id", "version"]) {
    if (typeof definition[key] !== "string" || (definition[key] as string).trim() === "") {
      return `The definition needs a "${key}" string.`;
    }
  }
  const root = definition["root"];
  if (!record(root) || root["type"] !== "form") {
    return 'The definition needs a "root" component of type "form".';
  }
  if (guardDepth) {
    const stack: [unknown, number][] = [[root, 1]];
    while (stack.length > 0) {
      const [node, level] = stack.pop() as [unknown, number];
      if (!record(node)) {
        continue;
      }
      if (level > 32) {
        return "Components nest more than 32 levels deep: the validator reads at most 32.";
      }
      if (record(node["children"])) {
        for (const list of Object.values(node["children"])) {
          for (const child of Array.isArray(list) ? list : []) {
            stack.push([child, level + 1]);
          }
        }
      }
    }
  }
  return undefined;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

function nesting(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (inString) {
      if (char === "\\") {
        at += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth += 1;
      max = Math.max(max, depth);
    } else if (char === "}" || char === "]") {
      depth -= 1;
    }
  }
  return max;
}

function nonFinite(value: unknown): boolean {
  if (typeof value === "number") {
    return !Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.some(nonFinite);
  }
  if (record(value)) {
    return Object.values(value).some(nonFinite);
  }
  return false;
}
