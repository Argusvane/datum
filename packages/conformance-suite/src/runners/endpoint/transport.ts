import { Agent as HttpAgent, request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { Socket } from "node:net";

/**
 * How long one HTTP exchange took, in milliseconds. `firstByteMs` and `totalMs` count from the
 * moment the TCP connection is open (on https the TLS handshake comes after that, so it is inside
 * both: it is the server's or its terminator's work): they are the server's time plus the wire,
 * never the suite's pacing pause or anything queued in the client. `connectMs` is the time before
 * (DNS and TCP connect, to the proxy when one is used); null when the transport cannot tell.
 */
export interface ExchangeTiming {
  connectMs: number | null;
  /** The first byte of the answer. */
  firstByteMs: number;
  /** The last byte of the answer. */
  totalMs: number;
}

export interface TransportRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs: number;
  /** Bytes of the answer kept; past this the answer is cut and marked truncated. */
  maxResponseBytes: number;
}

export interface TransportResponse {
  status: number;
  /** Lower-case names; repeated headers joined with ", ". */
  headers: Record<string, string>;
  bytes: Uint8Array;
  truncated: boolean;
  timing: ExchangeTiming;
}

/**
 * Why an exchange produced no answer. `phase` says whether the answer had started (a cut-off answer)
 * or not. `waited` is how long the exchange ran before it failed, timed as {@link ExchangeTiming}
 * (from the open connection, or from the call when the connection never opened); `sent` is false when
 * the connection never opened, so no byte of the request went out.
 */
export class TransportFailure extends Error {
  constructor(
    message: string,
    public readonly timedOut: boolean,
    public readonly phase: "request" | "response",
    public readonly waited: { sent: boolean; ms: number; connectMs: number | null } = { sent: false, ms: 0, connectMs: null }
  ) {
    super(message);
    this.name = "TransportFailure";
  }
}

/**
 * One HTTP exchange on a connection of its own (node:http / node:https, `agent: false`,
 * `Connection: close`), the endpoint mode's default transport. Under `NODE_USE_ENV_PROXY` (which is
 * what makes Node's fetch and global agent honour `HTTP(S)_PROXY` / `NO_PROXY`), the connection is
 * made by a one-off Agent built with `proxyEnv` instead, so a site reachable only through that proxy
 * stays reachable; `agent: false` alone ignores the proxy variables.
 *
 * Why not the global fetch (undici): Node 26's undici (8.x) validates an idle keep-alive socket
 * before reusing it with an `unref()`ed `setImmediate`. A request dispatched from a timer callback
 * (the suite's pacing pause) on a reused socket then waits for that immediate, and an unref'd
 * immediate does not stop the event loop from blocking in its poll phase: the loop sleeps until
 * the next timer or I/O event, which in a quiet run is an earlier request's 30 s abort timer.
 * RES-11 measured 15 to 25 s with no byte on the wire and both processes idle. A fresh connection per request never reuses a
 * socket, so there is nothing to validate; it also means a connection the server refused early
 * (a 413 before reading a 1 MiB body) or closed on its keep-alive timeout is never handed to the
 * next request.
 *
 * A response that arrives before the request body is fully written (the server refused early)
 * is read to its end and the connection is then destroyed: the rest of the body is discarded,
 * and a write error after the answer arrived (EPIPE, ECONNRESET) is not a failure.
 */
export function exchangeOverHttp(request: TransportRequest): Promise<TransportResponse> {
  const url = new URL(request.url);
  const send = url.protocol === "https:" ? httpsRequest : url.protocol === "http:" ? httpRequest : undefined;
  if (send === undefined) {
    return Promise.reject(new TransportFailure(`unsupported protocol ${url.protocol}`, false, "request"));
  }
  const body = request.body === undefined ? undefined : typeof request.body === "string" ? Buffer.from(request.body, "utf8") : Buffer.from(request.body.buffer, request.body.byteOffset, request.body.byteLength);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name.toLowerCase()] = value;
  }
  headers["connection"] = "close";
  if (body !== undefined) {
    headers["content-length"] = String(body.length);
  } else if (request.method === "POST" || request.method === "PUT") {
    headers["content-length"] = "0";
  }

  return new Promise<TransportResponse>((resolve, reject) => {
    const queued = performance.now();
    let writeStart: number | undefined;
    let firstByte: number | undefined;
    let response: IncomingMessage | undefined;
    let settled = false;
    let req: ClientRequest;

    const startedAt = (): number => writeStart ?? queued;
    const finish = (outcome: { ok: true; value: TransportResponse } | { ok: false; error: TransportFailure }): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      // Nothing more is read or written on this connection: an unsent rest of the body is discarded.
      req.destroy();
      if (outcome.ok) {
        resolve(outcome.value);
      } else {
        reject(outcome.error);
      }
    };

    const waited = (): { sent: boolean; ms: number; connectMs: number | null } => ({
      sent: writeStart !== undefined,
      ms: Math.max(0, performance.now() - startedAt()),
      connectMs: writeStart === undefined ? null : writeStart - queued
    });
    const failure = (message: string, timedOut: boolean, phase: "request" | "response"): { ok: false; error: TransportFailure } => ({ ok: false, error: new TransportFailure(message, timedOut, phase, waited()) });

    const timer = setTimeout(() => {
      finish(failure(`no answer within ${request.timeoutMs} ms`, true, response === undefined ? "request" : "response"));
    }, request.timeoutMs);

    const agent = proxyAgentFor(url.protocol);
    try {
      req = send(url, { method: request.method, headers, agent: agent ?? false });
    } catch (error) {
      clearTimeout(timer);
      agent?.destroy();
      reject(new TransportFailure(describe(error), false, "request"));
      return;
    }
    if (agent !== undefined) {
      req.once("close", () => agent.destroy());
    }

    req.on("socket", (socket: Socket) => {
      const markWrite = (): void => {
        writeStart ??= performance.now();
      };
      // A fresh socket: timing starts once the TCP connection is open. On https the TLS handshake
      // follows and is counted: a slow handshake is the host's (or its terminator's) time.
      socket.once("connect", markWrite);
      socket.once("data", () => {
        firstByte ??= performance.now();
      });
    });

    req.on("response", (incoming) => {
      response = incoming;
      firstByte ??= performance.now();
      const chunks: Buffer[] = [];
      let total = 0;
      let truncated = false;
      const done = (): void => {
        const end = performance.now();
        const from = startedAt();
        const headerMap: Record<string, string> = {};
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) {
            headerMap[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
          }
        }
        finish({
          ok: true,
          value: {
            status: incoming.statusCode ?? 0,
            headers: headerMap,
            bytes: new Uint8Array(Buffer.concat(chunks, total)),
            truncated,
            timing: {
              connectMs: writeStart === undefined ? null : writeStart - queued,
              firstByteMs: Math.max(0, (firstByte ?? end) - from),
              totalMs: Math.max(0, end - from)
            }
          }
        });
      };
      incoming.on("data", (chunk: Buffer) => {
        if (settled || truncated) {
          return;
        }
        if (total + chunk.length > request.maxResponseBytes) {
          chunks.push(chunk.subarray(0, request.maxResponseBytes - total));
          total = request.maxResponseBytes;
          truncated = true;
          done();
          return;
        }
        chunks.push(chunk);
        total += chunk.length;
      });
      incoming.on("end", done);
      incoming.on("aborted", () => finish(failure("the connection closed before the answer was complete", false, "response")));
      incoming.on("error", (error) => finish(failure(describe(error), false, "response")));
      incoming.on("close", () => {
        if (!incoming.complete) {
          finish(failure("the connection closed before the answer was complete", false, "response"));
        }
      });
    });

    req.on("error", (error) => {
      if (response !== undefined) {
        // The answer is in (or coming): an EPIPE or reset while the rest of the body was still going out
        // is the server refusing early, and the answer decides. A cut-off answer is caught on the response.
        return;
      }
      finish(failure(describe(error), false, "request"));
    });

    if (body !== undefined && body.length > 0) {
      req.end(body);
    } else {
      req.end();
    }
  });
}

/** A one-off Agent that honours the proxy variables, when the operator turned them on for Node (`NODE_USE_ENV_PROXY`). */
function proxyAgentFor(protocol: string): HttpAgent | undefined {
  const flag = process.env["NODE_USE_ENV_PROXY"];
  if (flag === undefined || flag === "" || flag === "0" || flag === "false") {
    return undefined;
  }
  const options = { keepAlive: false, maxSockets: 1, proxyEnv: process.env } as ConstructorParameters<typeof HttpAgent>[0];
  return protocol === "https:" ? new HttpsAgent(options) : new HttpAgent(options);
}

function describe(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") {
    return code;
  }
  return error instanceof Error ? error.message : String(error);
}
