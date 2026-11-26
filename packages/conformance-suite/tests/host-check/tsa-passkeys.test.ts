import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runHostCheckCli } from "../../src/host-check/cli.js";
import { contains, outermostTag, pkiStatus, randomNonce, timeStampRequest } from "../../src/host-check/crypto/tsa-der.js";
import type { HostCheckReport } from "../../src/host-check/report.js";

// A small host with the TSA and the passkey routes as the Spring examples answer them, and a `broken` switch per
// rule, so each assertion of the ports is shown to fail when its rule is broken.
interface Options {
  signIn?: boolean;
  broken?: "cookie-not-refused" | "no-store-missing" | "status-ok-for-garbage" | "nonce-dropped" | "token-reusable" | "other-sees-passkey" | "tsa-off" | "nonce-altered" | "octet-accepted" | "der-not-a-sequence" | "challenge-before-bad-request" | "visitor-gets-challenge";
}

const DER_SEQ = (...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([0x30, body.length < 0x80 ? body.length : 0x82]), ...(body.length < 0x80 ? [] : [Buffer.from([body.length >> 8, body.length & 0xff])]), body]);
};
const status = (value: number): Buffer => DER_SEQ(Buffer.from([0x02, 0x01, value]));

function read(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function json(response: ServerResponse, code: number, body: unknown): void {
  response.writeHead(code, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
const refuse = (response: ServerResponse, code: number, id: string): void => json(response, code, { errors: [{ code: id, message: id }] });

async function start(options: Options = {}): Promise<{ url: string; server: Server }> {
  const issued = new Set<string>();
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://x");
      const who = request.headers["x-person"];
      const body = await read(request);
      if (url.pathname === "/") return void response.end("ok");
      if (url.pathname === "/tsa" && request.method === "POST") {
        if (options.broken === "tsa-off") return void response.writeHead(404).end();
        if (options.broken !== "cookie-not-refused" && /JSESSIONID/.test(request.headers["cookie"] ?? "")) return void response.writeHead(403).end();
        const type = request.headers["content-type"];
        if (type !== "application/timestamp-query" && !(options.broken === "octet-accepted" && type === "application/octet-stream")) return void response.writeHead(415).end();
        let granted = true;
        try {
          if (outermostTag(body) !== 0x30) granted = false;
        } catch {
          granted = false;
        }
        const headers: Record<string, string> = { "Content-Type": "application/timestamp-reply" };
        if (options.broken !== "no-store-missing") headers["Cache-Control"] = "no-store, no-cache";
        if (!granted) {
          response.writeHead(options.broken === "status-ok-for-garbage" ? 200 : 400, headers);
          return void response.end(DER_SEQ(status(options.broken === "status-ok-for-garbage" ? 0 : 2)));
        }
        response.writeHead(200, headers);
        let echoed = options.broken === "nonce-dropped" ? body.subarray(0, body.length - 20) : body;
        if (options.broken === "nonce-altered") {
          // The nonce INTEGER sits before the certReq BOOLEAN (3 bytes): change its last content byte, keep the digest whole.
          echoed = Buffer.from(body);
          echoed[echoed.length - 4] = (echoed[echoed.length - 4] as number) ^ 0xff;
        }
        return void response.end(DER_SEQ(status(0), echoed));
      }
      if (url.pathname.startsWith("/tsa/certificate")) {
        if (url.pathname === "/tsa/certificate" && url.searchParams.get("format") === "der") {
          response.writeHead(200, { "Content-Type": "application/pkix-cert" });
          return void response.end(options.broken === "der-not-a-sequence" ? Buffer.from([0x02, 0x01, 1]) : DER_SEQ(Buffer.from([0x02, 0x01, 1])));
        }
        response.writeHead(200, { "Content-Type": "application/x-pem-file" });
        return void response.end("-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n");
      }
      if (url.pathname === "/api/webauthn/passkeys" && request.method === "GET") {
        if (url.searchParams.has("form")) return json(response, 200, { passkeys: [], signing: { mode: "required", ready: true, signIn: options.signIn ?? true } });
        return json(response, 200, { passkeys: who === "person" || options.broken === "other-sees-passkey" ? [] : [] });
      }
      if (url.pathname.startsWith("/api/webauthn/passkeys/") && request.method === "DELETE") {
        return options.broken === "other-sees-passkey" ? json(response, 200, {}) : refuse(response, 404, "passkey.not_found");
      }
      if (url.pathname === "/api/webauthn/challenge") {
        if (!request.headers["content-type"]?.startsWith("application/json")) return refuse(response, 415, "request.unsupported_media_type");
        if (!who) return options.signIn === false || options.broken === "visitor-gets-challenge" ? json(response, 200, { challenge: "c" }) : refuse(response, 403, "signing.sign_in");
        const token = `t${issued.size}`;
        issued.add(token);
        return json(response, 200, { challenge: "c", token, expires: 1, rp: { id: "localhost" }, user: { id: "u" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }] });
      }
      if (url.pathname === "/api/webauthn/register") {
        const posted = JSON.parse(body.toString("utf8")) as { credential?: unknown; token?: string };
        if (options.broken === "challenge-before-bad-request" && (posted.token === undefined || !issued.has(posted.token))) return refuse(response, 400, "passkey.challenge");
        if (posted.credential === undefined) return refuse(response, 400, "passkey.bad_request");
        if (posted.token === undefined || !issued.has(posted.token)) return refuse(response, 400, "passkey.challenge");
        if (options.broken !== "token-reusable") issued.delete(posted.token);
        return refuse(response, 422, "passkey.invalid");
      }
      response.writeHead(404).end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

const servers: Server[] = [];
afterEach(() => {
  while (servers.length > 0) servers.pop()?.close();
});

async function run(options: Options, capabilities: string, extra: string[] = []): Promise<{ code: number; out: string; err: string; report?: HostCheckReport }> {
  const host = await start(options);
  servers.push(host.server);
  const out = mkdtempSync(join(tmpdir(), "datum-host-check-tsa-"));
  let stdout = "";
  let stderr = "";
  try {
    const code = await runHostCheckCli(["--endpoint", host.url, "--capabilities", capabilities, "--out", out, ...extra], { stdout: (text) => void (stdout += text), stderr: (text) => void (stderr += text) });
    let report: HostCheckReport | undefined;
    try {
      report = JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as HostCheckReport;
    } catch {
      report = undefined;
    }
    return { code, out: stdout, err: stderr, ...(report !== undefined ? { report } : {}) };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const PERSONAS = ["--person-header", "X-Person=person", "--other-person-header", "X-Person=other"];

describe("the DER helpers", () => {
  it("write a TimeStampReq the reader takes apart and find bytes in a reply", () => {
    const digest = new Uint8Array(32).fill(7);
    const nonce = randomNonce();
    const request = timeStampRequest(digest, nonce);
    expect(outermostTag(request)).toBe(0x30);
    expect(contains(request, digest)).toBe(true);
    expect(contains(request, nonce)).toBe(true);
    expect(contains(request, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBe(false);
    expect(pkiStatus(new Uint8Array(DER_SEQ(status(2))))).toBe(2);
    expect(() => pkiStatus(new Uint8Array([1, 2, 3]))).toThrow();
  });
});

describe("tsa", () => {
  it("passes the four cases against a good server", async () => {
    const result = await run({}, "tsa");
    expect(result.code, result.out + result.err).toBe(0);
    expect(result.report?.results.map((entry) => `${entry.id}:${entry.status}`)).toEqual(["TSA-01:PASS", "TSA-02:PASS", "TSA-03:PASS", "TSA-04:PASS"]);
  });

  it.each([
    ["no-store-missing", "TSA-01"],
    ["nonce-dropped", "TSA-01"],
    ["nonce-altered", "TSA-01"],
    ["octet-accepted", "TSA-03"],
    ["der-not-a-sequence", "TSA-04"],
    ["status-ok-for-garbage", "TSA-02"],
    ["cookie-not-refused", "TSA-03"]
  ] as const)("fails %s on %s", async (broken, id) => {
    const result = await run({ broken }, "tsa");
    expect(result.code, result.out + result.err).toBe(1);
    expect(result.report?.results.find((entry) => entry.id === id)?.status).toBe("FAIL");
  });

  it("names the nonce when only the nonce is wrong", async () => {
    const result = await run({ broken: "nonce-altered" }, "tsa");
    expect(result.out + result.err).toContain("nonce");
    expect(result.out + result.err).not.toContain("names the digest");
  });

  it("is inconclusive (exit 3) when the timestamp server is off", async () => {
    const result = await run({ broken: "tsa-off" }, "tsa");
    expect(result.code, result.out + result.err).toBe(3);
    expect(result.out + result.err).toContain("--tsa-path");
  });
});

describe("passkeys", () => {
  it("passes the four cases against a good server that wants a sign-in", async () => {
    const result = await run({}, "passkeys", ["--signing-form", "sign-me", ...PERSONAS]);
    expect(result.code, result.out + result.err).toBe(0);
    expect(result.report?.results.map((entry) => `${entry.id}:${entry.status}`)).toEqual(["PKY-01:PASS", "PKY-02:PASS", "PKY-03:PASS", "PKY-04:PASS"]);
  });

  it("passes against a server where a visitor may ask for a challenge", async () => {
    const result = await run({ signIn: false }, "passkeys", ["--signing-form", "sign-me", ...PERSONAS]);
    expect(result.code, result.out + result.err).toBe(0);
  });

  it("without --signing-form skips PKY-01..03 and still runs PKY-04, as the Java HostTck does (exit 0)", async () => {
    const result = await run({}, "passkeys", PERSONAS);
    expect(result.code, result.out + result.err).toBe(0);
    expect(result.report?.results.map((entry) => `${entry.id}:${entry.status}`)).toEqual(["PKY-01:SKIP", "PKY-02:SKIP", "PKY-03:SKIP", "PKY-04:PASS"]);
  });

  it.each([
    ["challenge-before-bad-request", "PKY-03"],
    ["visitor-gets-challenge", "PKY-02"]
  ] as const)("fails %s on %s", async (broken, id) => {
    const result = await run({ broken }, "passkeys", ["--signing-form", "sign-me", ...PERSONAS]);
    expect(result.code, result.out + result.err).toBe(1);
    expect(result.report?.results.find((entry) => entry.id === id)?.status).toBe("FAIL");
  });

  it("fails a register token that can be used twice, and another person's passkey that is found", async () => {
    const reused = await run({ broken: "token-reusable" }, "passkeys", ["--signing-form", "sign-me", ...PERSONAS]);
    expect(reused.code).toBe(1);
    expect(reused.report?.results.find((entry) => entry.id === "PKY-03")?.status).toBe("FAIL");
    const found = await run({ broken: "other-sees-passkey" }, "passkeys", ["--signing-form", "sign-me", ...PERSONAS]);
    expect(found.code).toBe(1);
    expect(found.report?.results.find((entry) => entry.id === "PKY-04")?.status).toBe("FAIL");
  });
});
