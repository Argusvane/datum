import { execFile } from "node:child_process";
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";

import { Ajv } from "ajv";
import { afterEach, describe, expect, it } from "vitest";

import type { Report } from "../src/report/model.js";
import { REPORT_SCHEMA } from "../src/report/schema.js";
import { Budget } from "../src/runners/endpoint/budget.js";
import { EARLIER_ENDPOINT_SPECS } from "../src/runners/endpoint/applicability.js";
import { runEndpoint } from "../src/runners/endpoint/endpoint-runner.js";
import { HttpClient, routesFor, type EndpointTarget } from "../src/runners/endpoint/http.js";
import { withEndpoint } from "../src/runners/endpoint/report.js";
import { exchangeOverHttp } from "../src/runners/endpoint/transport.js";
import { catalogueWithEveryEndpointSpec } from "./helpers/catalogue.js";
import { configFor } from "./helpers/endpoint.js";
import { PACKAGE_ROOT } from "./helpers/paths.js";
import { startReferenceServer } from "./helpers/reference-submissions-server.js";

/**
 * The endpoint mode's own transport (src/runners/endpoint/transport.ts): one connection per request,
 * timed from the open connection. The RES-11 stall came from Node's global
 * fetch reusing a keep-alive socket; these tests hold the replacement to the three situations
 * around it: a server that refuses a big body early without reading it, a server that drops idle
 * keep-alive connections, and the pacing pause, which must never count as the server's time.
 */

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length > 0) {
    await closers.pop()?.();
  }
});

async function listen(server: Server | NetServer): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no port");
  }
  return `http://127.0.0.1:${address.port}`;
}

const target = (baseUrl: string): EndpointTarget => ({ baseUrl, profile: "submissions", formId: "fx", formVersion: "1", allowWrites: false });

function clientFor(baseUrl: string, delayMs = 0, timeoutMs = 10_000): HttpClient {
  return new HttpClient({ target: target(baseUrl), budget: new Budget({ maxRequests: 100, delayMs }), timeoutMs, headers: {} });
}

/**
 * A server in front of the reference server: forwards every request, except that a request whose
 * Content-Length is over `hangOver` is never read and never answered (a host that stalls on an
 * over-limit body), and that answers to the check route are held back `delayValidateMs`.
 */
async function startFront(upstream: string, options: { hangOver?: number; delayValidateMs?: number }): Promise<string> {
  const target = new URL(upstream);
  const server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    if (options.hangOver !== undefined && Number(request.headers["content-length"] ?? "0") > options.hangOver) {
      request.pause();
      return;
    }
    const forward = httpRequest({ host: target.hostname, port: target.port, method: request.method, path: request.url, headers: request.headers }, (answer) => {
      const delay = options.delayValidateMs !== undefined && request.url?.endsWith("/validate") === true ? options.delayValidateMs : 0;
      const chunks: Buffer[] = [];
      answer.on("data", (chunk: Buffer) => chunks.push(chunk));
      answer.on("end", () => setTimeout(() => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        response.end(Buffer.concat(chunks));
      }, delay));
    });
    forward.on("error", () => response.destroy());
    request.pipe(forward);
  });
  const url = await listen(server);
  closers.push(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return url;
}

const JSON_OK = JSON.stringify({ accepted: true, errors: [] });
const JSON_413 = JSON.stringify({ errors: [{ field: null, code: "request_refused", parameters: { reason: "too_large" } }] });

/**
 * A raw TCP server: a request whose Content-Length is over `limit` gets a 413 the moment its headers
 * are in, and the socket is never read again (the body stays unread); any other request is read
 * whole and answered 200. Records each connection and when the server saw it close.
 */
function startEarlyRefuser(limit: number): { server: NetServer; connections: { id: number; closedAt?: number; refused: boolean }[] } {
  const connections: { id: number; closedAt?: number; refused: boolean }[] = [];
  const server = createNetServer((socket: Socket) => {
    const record: { id: number; closedAt?: number; refused: boolean } = { id: connections.length + 1, refused: false };
    connections.push(record);
    socket.on("close", () => {
      record.closedAt = performance.now();
    });
    socket.on("error", () => undefined);
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        return;
      }
      const head = buffer.subarray(0, end).toString("latin1");
      const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? "0");
      if (length > limit) {
        socket.off("data", onData);
        socket.pause();
        record.refused = true;
        socket.write(`HTTP/1.1 413 Payload Too Large\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(JSON_413)}\r\nConnection: close\r\n\r\n${JSON_413}`);
        // Read nothing for a while (the client must not wait on it), then drain so the close can be seen.
        setTimeout(() => socket.resume(), 300).unref();
        return;
      }
      if (buffer.length - (end + 4) >= length) {
        socket.off("data", onData);
        socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(JSON_OK)}\r\nConnection: close\r\n\r\n${JSON_OK}`);
      }
    };
    socket.on("data", onData);
  });
  return { server, connections };
}

describe("the endpoint transport: a server that refuses a big body early", () => {
  it("takes the 413 the server sends before reading the body, drops the connection, and answers the next request on a new one", async () => {
    const { server, connections } = startEarlyRefuser(1024);
    const url = await listen(server);
    closers.push(() => new Promise((resolve) => server.close(() => resolve())));
    const http = clientFor(url);
    const validate = routesFor(target(url)).validate;

    // 16 MiB: far more than the loopback socket buffers, so the write is still blocked when the answer comes.
    const big = new Uint8Array(16 * 1024 * 1024).fill(0x78);
    const started = performance.now();
    const refused = await http.send({ method: "POST", url: validate, headers: { "content-type": "application/json" }, body: big, label: "big" });
    const refusedAfter = performance.now() - started;
    expect(refused.status).toBe(413);
    expect(refused.jsonOk).toBe(true);
    expect(refused.timing.totalMs).toBeLessThan(2000);
    expect(refusedAfter).toBeLessThan(3000);
    expect(refused.timing.firstByteMs).toBeLessThanOrEqual(refused.timing.totalMs);

    const next = await http.send({ method: "POST", url: validate, headers: { "content-type": "application/json" }, body: "{}", label: "next" });
    expect(next.status).toBe(200);
    expect(next.timing.totalMs).toBeLessThan(2000);
    expect(connections.map((connection) => connection.refused)).toEqual([true, false]);

    // The client closed the refused connection itself (the server never read to the end of the body).
    await expect.poll(() => connections[0]?.closedAt, { timeout: 3000 }).toBeDefined();
  });

  it("reports a refusal the server sends while the body is still going out as the answer, not as a transport error", async () => {
    const { server } = startEarlyRefuser(0);
    const url = await listen(server);
    closers.push(() => new Promise((resolve) => server.close(() => resolve())));
    const answer = await exchangeOverHttp({ method: "POST", url: `${url}/x`, headers: {}, body: new Uint8Array(8 * 1024 * 1024), timeoutMs: 5000, maxResponseBytes: 1024 });
    expect(answer.status).toBe(413);
    expect(new TextDecoder().decode(answer.bytes)).toBe(JSON_413);
  });
});

describe("the endpoint transport: a server that drops idle keep-alive connections after 1 s", () => {
  it("never reuses a connection: each paced request opens its own, says Connection: close, and is answered", async () => {
    const sockets = new Set<unknown>();
    const seen: { connection: string | undefined; userAgent: string | undefined }[] = [];
    const server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
      sockets.add(request.socket);
      seen.push({ connection: request.headers.connection, userAgent: request.headers["user-agent"] });
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON_OK);
      });
    });
    server.keepAliveTimeout = 1000;
    const url = await listen(server);
    closers.push(() => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }));
    // A pause longer than the server's keep-alive: a reused connection would be closed under the next request.
    const http = clientFor(url, 1200);
    const validate = routesFor(target(url)).validate;
    for (let at = 0; at < 3; at += 1) {
      const answer = await http.send({ method: "POST", url: validate, headers: { "content-type": "application/json" }, body: "{}", label: `#${at}` });
      expect(answer.status).toBe(200);
      expect(answer.timing.totalMs).toBeLessThan(1000);
    }
    expect(sockets.size).toBe(3);
    expect(seen.every((entry) => entry.connection === "close")).toBe(true);
    expect(seen.every((entry) => entry.userAgent?.startsWith("datum-security-check/") === true)).toBe(true);
  }, 20_000);
});

describe("the endpoint transport: no stall on a quiet event loop (the RES-11 mechanism)", () => {
  it("writes each paced request at once in a process that has nothing else to do", async () => {
    // A keep-alive server that answers in 50 ms. Under the global fetch, a request dispatched from the pacing
    // timer onto the reused socket waited for undici's unref'd validation immediate, i.e. for the next timer
    // or I/O event in the client process: by hand (the client's "fetch" mode) 100 to 750 ms here, and 15 to
    // 25 s in a suite run, where the next timer was an earlier request's 30 s abort timer.
    const server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
      request.resume();
      request.on("end", () => setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json", "keep-alive": "timeout=60" });
        response.end(JSON_OK);
      }, 50));
    });
    server.keepAliveTimeout = 60_000;
    const url = await listen(server);
    closers.push(() => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }));
    const viteNode = `${PACKAGE_ROOT}/node_modules/.bin/vite-node`;
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(viteNode, ["tests/helpers/quiet-loop-client.ts", url, "6"], { cwd: PACKAGE_ROOT, timeout: 120_000 }, (error, out) => (error ? reject(error) : resolve(out)));
    });
    const sends = JSON.parse(stdout.trim().split("\n").at(-1) as string) as { wallMs: number; totalMs: number; status: number }[];
    // The control: the same harness with the global fetch as the transport still shows the stall, so
    // the harness reproduces a quiet loop (a reused socket waits on undici's unref'd immediate).
    const control = await new Promise<string>((resolve, reject) => {
      execFile(viteNode, ["tests/helpers/quiet-loop-client.ts", url, "6", "fetch"], { cwd: PACKAGE_ROOT, timeout: 120_000 }, (error, out) => (error ? reject(error) : resolve(out)));
    });
    const fetched = JSON.parse(control.trim().split("\n").at(-1) as string) as { wallMs: number; totalMs: number; status: number }[];
    expect(fetched.every((send) => send.status === 200)).toBe(true);
    // Whether the stall shows under the control is the runner's: on the 2-vCPU CI runner the global
    // fetch answered every send in 52 to 79 ms on some runs and showed the stall on others. A quiet control is noted, not a failure: the claim under test is the
    // transport's own line below, which never waits on the immediate at all.
    const controlStallMs = Math.max(...fetched.map((send) => send.totalMs));
    if (controlStallMs < 100) console.warn(`quiet-loop control: the global fetch showed no stall here (max ${controlStallMs} ms): ${JSON.stringify(fetched)}`);
    expect(sends).toHaveLength(6);
    for (const send of sends) {
      expect(send.status).toBe(200);
      // A 250 ms pause and a 50 ms answer: the exchange is the 50 ms plus the wire.
      expect(send.wallMs, JSON.stringify(sends)).toBeLessThan(2000);
      expect(send.totalMs, JSON.stringify(sends)).toBeLessThan(250);
    }
  }, 150_000);
});

describe("the endpoint transport: what the time bound measures", () => {
  it("times the exchange itself: first byte and last byte from the open connection, the pacing pause left out", async () => {
    const server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
      request.resume();
      request.on("end", () => {
        setTimeout(() => {
          response.writeHead(200, { "content-type": "application/json" });
          response.write('{"accepted":true,');
          setTimeout(() => response.end('"errors":[]}'), 200);
        }, 200);
      });
    });
    const url = await listen(server);
    closers.push(() => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }));
    const http = clientFor(url, 1000);
    const validate = routesFor(target(url)).validate;
    await http.send({ method: "POST", url: validate, headers: { "content-type": "application/json" }, body: "{}", label: "first" });
    const started = performance.now();
    const answer = await http.send({ method: "POST", url: validate, headers: { "content-type": "application/json" }, body: "{}", label: "paced" });
    const wall = performance.now() - started;
    expect(answer.jsonOk).toBe(true);
    // The send waited out the 1000 ms pause; the exchange did not count it.
    expect(wall).toBeGreaterThanOrEqual(1000);
    expect(answer.timing.firstByteMs).toBeGreaterThanOrEqual(150);
    expect(answer.timing.firstByteMs).toBeLessThan(answer.timing.totalMs);
    expect(answer.timing.totalMs).toBeGreaterThanOrEqual(350);
    expect(answer.timing.totalMs).toBeLessThan(950);
    expect(answer.elapsedMs).toBe(answer.timing.totalMs);
    expect(answer.timing.connectMs).not.toBeNull();
    const exchange = http.exchanges.at(-1);
    expect(exchange?.firstByteMs).toBe(answer.timing.firstByteMs);
    expect(exchange?.elapsedMs).toBe(answer.timing.totalMs);
  }, 20_000);

  it("names a server that never answers as a timeout", async () => {
    const server = createNetServer((socket) => {
      socket.on("error", () => undefined);
      socket.resume();
    });
    const url = await listen(server);
    closers.push(() => new Promise((resolve) => server.close(() => resolve())));
    const http = clientFor(url, 0, 300);
    const failed = http.send({ method: "POST", url: routesFor(target(url)).validate, body: "{}" });
    await expect(failed).rejects.toMatchObject({ name: "TransportError", timedOut: true, waited: { sent: true } });
    // The wait is carried: the time bound and report.json see the hang, not 0 ms.
    const waited = await failed.catch((error: { waited: { ms: number } }) => error.waited.ms);
    expect(waited).toBeGreaterThanOrEqual(250);
  });

  it("counts a hang's whole wait in the row's exchange (requests 1, the times the wait), so the time bound sees it", async () => {
    // Hangs on RES-11's check only (the run's own probes are answered).
    const server = await startReferenceServer({ fault: (request) => (request.bodyText.includes(`${"a".repeat(40)}!`) ? { hang: true, status: 200, body: "" } : undefined) });
    closers.push(() => server.close());
    const run = await runEndpoint(configFor(server.url, { vectors: catalogueWithEveryEndpointSpec(), only: ["RES-11"], timeoutMs: 400 }));
    const res11 = run.results.find((result) => result.id === "RES-11");
    expect(res11?.status).toBe("FAIL");
    expect(res11?.exchange?.requests).toBe(1);
    expect(res11?.exchange?.totalMs ?? 0).toBeGreaterThanOrEqual(350);
    expect(res11?.exchange?.firstByteMs ?? 0).toBeGreaterThanOrEqual(350);
  }, 30_000);

  it("names an answer the server cuts off as cut off", async () => {
    const server = createNetServer((socket) => {
      socket.on("error", () => undefined);
      socket.once("data", () => {
        socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"accepted\":");
        setTimeout(() => socket.destroy(), 50);
      });
    });
    const url = await listen(server);
    closers.push(() => new Promise((resolve) => server.close(() => resolve())));
    const http = clientFor(url);
    await expect(http.send({ method: "POST", url: routesFor(target(url)).validate, body: "{}" })).rejects.toMatchObject({ name: "TransportError", timedOut: false, message: expect.stringContaining("the answer was cut off") });
  });

  it("names a refused connection as one", async () => {
    const server = createNetServer();
    const url = await listen(server);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const http = clientFor(url);
    await expect(http.send({ method: "POST", url: routesFor(target(url)).validate, body: "{}" })).rejects.toMatchObject({ name: "TransportError", timedOut: false, message: expect.stringContaining("ECONNREFUSED"), waited: { sent: false, connectMs: null } });
  });

  it("reports the exchange of each endpoint result and row in report.json, and judges the time bound on it", async () => {
    const server = await startReferenceServer();
    closers.push(() => server.close());
    const run = await runEndpoint(configFor(server.url, { vectors: catalogueWithEveryEndpointSpec(), only: ["RES-05", "RES-06", "RES-08", "RES-11"], delayMs: 300 }));
    const res11 = run.results.find((result) => result.id === "RES-11");
    expect(res11?.status).toBe("PASS");
    expect(res11?.limitMs).toBe(10_000);
    expect(res11?.exchange).toMatchObject({ requests: 1 });
    expect(res11?.exchange?.firstByteMs).toBeLessThanOrEqual(res11?.exchange?.totalMs ?? -1);
    // The 300 ms pause before the request is in the wall time, not in the exchange.
    expect(res11?.durationMs ?? 0).toBeGreaterThanOrEqual(300);
    expect(res11?.exchange?.totalMs ?? Infinity).toBeLessThan(res11?.durationMs ?? 0);
    expect(res11?.variants?.[0]?.exchange).toEqual(res11?.exchange);
    expect(res11?.exchange?.connectMs ?? -1).toBeGreaterThanOrEqual(0);
    const report = withEndpoint(undefined, run, { failOn: "fail", gate: "release", argv: [], startedAt: new Date(), startedMs: performance.now() }) as Report;
    const validate = new Ajv({ strict: false }).compile(REPORT_SCHEMA);
    expect(validate(JSON.parse(JSON.stringify(report))), JSON.stringify(validate.errors)).toBe(true);
  }, 60_000);

  it("fails RES-11 when the real transport's exchange runs past the row's bound", async () => {
    const server = await startReferenceServer();
    closers.push(() => server.close());
    const front = await startFront(server.url, { delayValidateMs: 600 });
    // RES-11's row bound cut to 300 ms for this run: the server's 600 ms answer is over it.
    const row = EARLIER_ENDPOINT_SPECS["RES-11"]?.rows[0];
    expect(row?.limitMs).toBe(10_000);
    row!.limitMs = 300;
    const run = await runEndpoint(configFor(front, { vectors: catalogueWithEveryEndpointSpec(), only: ["RES-11"], delayMs: 50 })).finally(() => {
      row!.limitMs = 10_000;
    });
    const res11 = run.results.find((result) => result.id === "RES-11");
    expect(res11?.limitMs).toBe(300);
    expect(res11?.status).toBe("FAIL");
    expect(res11?.notes ?? JSON.stringify(res11)).toMatch(/over the 300 ms bound/);
    expect(res11?.exchange?.totalMs ?? 0).toBeGreaterThanOrEqual(550);
  }, 30_000);
});

describe("the endpoint transport: a host that stalls on an over-limit body", () => {
  it("fails RES-05 and REC-03 when the host stops reading a body over the limit and never answers", async () => {
    const server = await startReferenceServer();
    closers.push(() => server.close());
    const front = await startFront(server.url, { hangOver: 1_048_576 });
    const run = await runEndpoint(configFor(front, { vectors: catalogueWithEveryEndpointSpec(), only: ["RES-05", "REC-03"], timeoutMs: 1500 }));
    for (const id of ["RES-05", "REC-03"]) {
      const result = run.results.find((entry) => entry.id === id);
      expect(result?.status, JSON.stringify(result)).toBe("FAIL");
      expect(result?.notes ?? "").toMatch(/budget|no answer/);
    }
  }, 60_000);
});

describe("the endpoint transport: an operator's proxy", () => {
  it("goes through HTTP_PROXY when NODE_USE_ENV_PROXY is on (agent: false alone would connect directly)", async () => {
    const seen: string[] = [];
    const proxy = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
      seen.push(`${request.method} ${request.url} ${request.headers["connection"] ?? ""}`);
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON_OK);
      });
    });
    const proxyUrl = await listen(proxy);
    closers.push(() => new Promise((resolve) => {
      proxy.closeAllConnections();
      proxy.close(() => resolve());
    }));
    const saved = { use: process.env["NODE_USE_ENV_PROXY"], http: process.env["HTTP_PROXY"], no: process.env["NO_PROXY"] };
    const put = (name: string, value: string | undefined): void => {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    };
    put("NODE_USE_ENV_PROXY", "1");
    put("HTTP_PROXY", proxyUrl);
    put("NO_PROXY", "");
    try {
      // A host name that resolves nowhere: only the proxy can answer for it.
      const answer = await exchangeOverHttp({ method: "POST", url: "http://suite-target.invalid/datum/fx/validate", headers: { "content-type": "application/json" }, body: "{}", timeoutMs: 5000, maxResponseBytes: 1024 });
      expect(answer.status).toBe(200);
      expect(seen).toEqual(["POST http://suite-target.invalid/datum/fx/validate close"]);
    } finally {
      put("NODE_USE_ENV_PROXY", saved.use);
      put("HTTP_PROXY", saved.http);
      put("NO_PROXY", saved.no);
    }
  });
});
