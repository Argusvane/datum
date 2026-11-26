import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { deflateSync } from "node:zlib";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { runHostCheckCli } from "../../src/host-check/cli.js";

/**
 * BLD and PDF against small stand-in hosts that answer as the Spring examples do (ui-builder-jpa and
 * webflux-pdf), one thing wrong at a time. The real examples were run against the built command; this
 * keeps the assertions honest without a JVM.
 */
const servers: Server[] = [];
afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop() as Server;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function start(handler: (method: string, url: string, headers: Record<string, string | string[] | undefined>, body: Buffer) => { status: number; headers?: Record<string, string>; body: string | Buffer }): Promise<string> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const answer = handler(request.method ?? "GET", request.url ?? "/", request.headers, Buffer.concat(chunks));
      response.writeHead(answer.status, answer.headers ?? {});
      response.end(answer.body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await runHostCheckCli(argv, { stdout: (text) => void (out += text), stderr: (text) => void (out += text) });
  return { code, out };
}

const err = (status: number, code: string, headers: Record<string, string> = {}) => ({ status, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ errors: [{ code, message: code }] }) });
const ok = (body: unknown, headers: Record<string, string> = {}) => ({ status: 200, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

interface BuilderFaults {
  visitorMaySave?: boolean;
  noTagOnSave?: boolean;
  /** The framework's own refusals: a bare 401 for the visitor, a bare 403 for the other person, no body. */
  frameworkRefusals?: boolean;
}

/** A builder host: the person is "Basic person", the other person "Basic other". */
async function builderHost(faults: BuilderFaults = {}): Promise<string> {
  let stored: Record<string, unknown> = { id: "intake", version: "1", root: { id: "root", type: "form", configuration: {}, children: { content: [] } } };
  const tagOf = (value: unknown): string => `"${createHash("sha256").update(JSON.stringify(value)).digest("hex")}"`;
  return start((method, url, headers, body) => {
    if (method === "GET" && url === "/") return { status: 200, body: "hello" };
    const who = headers["authorization"];
    if (method === "GET" && url === "/api/forms/intake/definition?public=false") {
      return who === "Basic person" ? ok(stored, { ETag: tagOf(stored) }) : err(403, "access.denied");
    }
    if (method === "PUT" && url === "/api/forms/intake") {
      if (who !== "Basic person" && faults.frameworkRefusals === true) return { status: who === undefined ? 401 : 403, body: "" };
      if (who !== "Basic person" && faults.visitorMaySave !== true) return err(403, "access.denied");
      if (headers["if-match"] !== tagOf(stored)) return err(409, "form.outdated", { ETag: tagOf(stored) });
      const definition = JSON.parse(body.toString("utf8")) as { id: string; version: string; root: { children: { content: { id: string; rules?: unknown }[] } } };
      if (definition.id !== "intake") return err(422, "definition.id.mismatch");
      const content = definition.root.children.content;
      if (content.some((c) => c.id === "tckfx")) return { status: 422, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ errors: [{ code: "pattern.risky", message: "x" }], kernel: [{ where: "rules:tckfx:visibleWhen" }] }) };
      if (content.filter((c) => c.id === "tckdup").length > 1) return err(422, "component.id.duplicate");
      stored = definition;
      const sha = tagOf(stored).slice(1, -1);
      return ok({ sha256: sha }, faults.noTagOnSave === true ? {} : { ETag: `"${sha}"` });
    }
    if (method === "POST" && url === "/api/forms") return err(409, "form.exists");
    return err(404, "form.notFound");
  });
}

const builderArgs = (url: string): string[] => ["--endpoint", url, "--capabilities", "builder", "--build-form", "intake", "--person-header", "Authorization=Basic person", "--other-person-header", "Authorization=Basic other"];

describe("BLD", () => {
  it("passes the four cases against a host that answers as the builder example does", async () => {
    const result = await run(builderArgs(await builderHost()));
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("== builder: 4 passed, 0 failed, 0 skipped");
  });

  it("passes BLD-01 when the host's own security refuses with a bare 401 and 403 (framework-first)", async () => {
    const result = await run(builderArgs(await builderHost({ frameworkRefusals: true })));
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("== builder: 4 passed, 0 failed, 0 skipped");
  });

  it("fails BLD-01 when a visitor may save", async () => {
    const result = await run(builderArgs(await builderHost({ visitorMaySave: true })));
    expect(result.code, result.out).toBe(1);
    expect(result.out).toMatch(/FAIL BLD-01/);
  });

  it("fails BLD-02 when a save answers no ETag", async () => {
    const result = await run(builderArgs(await builderHost({ noTagOnSave: true })));
    expect(result.code, result.out).toBe(1);
    expect(result.out).toMatch(/FAIL BLD-02/);
  });

  it("skips the whole group without --build-form (exit 2) and touches nothing", async () => {
    let touched = 0;
    const url = await start(() => {
      touched += 1;
      return { status: 200, body: "x" };
    });
    const result = await run(["--endpoint", url, "--capabilities", "builder"]);
    expect(result.code, result.out).toBe(2);
    expect(touched).toBe(0);
  });

  it("is inconclusive (exit 3) when the person may not read the build form", async () => {
    const url = await builderHost();
    const result = await run(["--endpoint", url, "--capabilities", "builder", "--build-form", "intake"]);
    expect(result.code, result.out).toBe(3);
    expect(result.out).toContain("--person-header");
  });
});

interface PdfFaults {
  server500?: boolean;
  unsealed?: boolean;
  /** host.json publishes the bindings table of two routes (the pdf-bindings case); false: it publishes none. */
  bindings?: { routes: Record<string, string>; themeHeaders?: Record<string, string>; drawnIn?: Record<string, string> };
}

const PDF = Buffer.from("%PDF-1.7\n%%EOF\n", "latin1");

/** A PDF whose one content stream (Flate, as the PDF program writes it) draws its text in this fill colour. */
function pdfFilling(fill: string): Buffer {
  const content = deflateSync(Buffer.from(`BT /F1 12 Tf ${fill} rg 72 720 Td (x) Tj ET`, "latin1"));
  return Buffer.concat([
    Buffer.from(`%PDF-1.7\n4 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
    content,
    Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1")
  ]);
}

/** The fill colour each PDF theme draws text in: datum-pdf's #111111 and the kit's #123456, as the PDF program writes them. */
const TEXT_FILL: Record<string, string> = { "datum-pdf": "0.0667 0.0667 0.0667", "datum-host-check-pdf": "0.0706 0.2039 0.3373" };

async function pdfHost(faults: PdfFaults = {}): Promise<string> {
  const fixture = {
    id: "datum-security-suite",
    version: "1",
    root: { id: "root", type: "form", configuration: { securitySuiteFixture: "1" }, children: { content: [] } }
  };
  return start((method, url, headers, body) => {
    const type = String(headers["content-type"] ?? "").split(";")[0];
    if (method === "GET" && url === "/") return { status: 200, body: "hello" };
    if (method === "GET" && url === "/api/forms/datum-security-suite/definition") return ok(fixture);
    if (method === "GET" && url === "/datum/assets/host.json" && faults.bindings !== undefined) {
      return ok({
        buildId: "b1",
        assetsBase: "/datum/assets/b1",
        apiBase: "/api",
        bindings: {
          default: "datum",
          routes: faults.bindings.routes,
          catalog: [
            { id: "datum", label: "Datum", pdfTheme: "datum-pdf" },
            { id: "host-check-binding", label: "Host check", pdfTheme: "datum-host-check-pdf" },
            { id: "ledger", label: "Ledger", pdfTheme: "ledger" }
          ]
        }
      });
    }
    if (method === "GET" && url === "/api/server/certificate") return { status: 200, headers: { "Content-Type": "application/x-pem-file" }, body: "-----BEGIN CERTIFICATE-----\nAA\n-----END CERTIFICATE-----\n" };
    if (method !== "POST") return err(404, "form.notFound");
    if (url === "/api/pdf" || url === "/api/pdf/sign") {
      if (type !== "application/json") return err(415, "media.unsupported");
      const text = body.toString("utf8");
      if (text.includes("\"name\":\"\"") || !text.includes("name")) return err(422, "required");
      if (faults.server500) return err(500, "internal");
      const sealed = url === "/api/pdf/sign" || faults.unsealed !== true;
      const form = /"id":"([^"]+)"/.exec(text)?.[1] ?? "";
      const named = faults.bindings?.themeHeaders?.[form];
      const drawnIn = faults.bindings?.drawnIn?.[form] ?? named;
      const fill = drawnIn !== undefined ? TEXT_FILL[drawnIn] : undefined;
      return {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "X-Page-Count": "1",
          ...(named !== undefined ? { "X-Datum-Pdf-Theme": named } : {}),
          ...(sealed ? { "X-Signed-By": url === "/api/pdf/sign" ? "Server" : "Datum+test+seal", "X-Signature-Field": "Signature1" } : {})
        },
        body: fill !== undefined ? pdfFilling(fill) : PDF
      };
    }
    if (url === "/api/pdf/fill") return err(404, "layout.notFound");
    if (url === "/api/pdf/verify") {
      if (type === "application/pdf") return body.toString("latin1").startsWith("%PDF-") ? ok({ signatures: faults.unsealed === true ? [] : [{ intact: true }] }) : err(400, "pdf.notAPdf");
      return err(415, "media.unsupported");
    }
    return err(404, "form.notFound");
  });
}

describe("PDF", () => {
  it("passes the five with --pdf-signing and skips the per-route case without --pdf-bindings", async () => {
    const result = await run(["--endpoint", await pdfHost(), "--capabilities", "pdf", "--pdf-signing"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("== pdf: 5 passed, 0 failed, 1 skipped");
    expect(result.out).toMatch(/SKIP PDF-06/);
  });

  it("skips the two seal cases without --pdf-signing, never passes them", async () => {
    const result = await run(["--endpoint", await pdfHost(), "--capabilities", "pdf"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("== pdf: 3 passed, 0 failed, 3 skipped");
    expect(result.out).toMatch(/SKIP PDF-03/);
    expect(result.out).toMatch(/SKIP PDF-05/);
  });

  const routed = (): PdfFaults => ({
    bindings: {
      routes: { "datum-security-suite-b": "host-check-binding" },
      themeHeaders: { "datum-security-suite": "datum-pdf", "datum-security-suite-b": "datum-host-check-pdf" }
    }
  });

  it("PDF-06 passes when two routes on one host get each route's catalog PDF theme", async () => {
    const result = await run(["--endpoint", await pdfHost(routed()), "--capabilities", "pdf", "--pdf-bindings", "--only", "PDF-06"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("== pdf: 1 passed, 0 failed, 0 skipped");
  });

  it("PDF-06 fails when a route's PDF names its theme but is drawn under the engine's own (the theme never reached the request)", async () => {
    const faults = routed();
    faults.bindings!.drawnIn = { "datum-security-suite-b": "datum-pdf" };
    const result = await run(["--endpoint", await pdfHost(faults), "--capabilities", "pdf", "--pdf-bindings", "--only", "PDF-06"]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toMatch(/FAIL PDF-06/);
    expect(result.out).toContain("the PDF of datum-security-suite-b is not drawn under datum-host-check-pdf");
  });

  it("PDF-06 fails when the other route's PDF is drawn under the kit's theme too", async () => {
    const faults = routed();
    faults.bindings!.drawnIn = { "datum-security-suite": "datum-host-check-pdf" };
    const result = await run(["--endpoint", await pdfHost(faults), "--capabilities", "pdf", "--pdf-bindings", "--only", "PDF-06"]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("the PDF of datum-security-suite is drawn with datum-host-check-pdf's text colour");
  });

  it("PDF-06 fails when the routed form's theme is not the kit's, whose drawing it can see", async () => {
    const faults = routed();
    faults.bindings!.routes = { "datum-security-suite-b": "ledger" };
    faults.bindings!.themeHeaders = { "datum-security-suite": "datum-pdf", "datum-security-suite-b": "ledger" };
    const result = await run(["--endpoint", await pdfHost(faults), "--capabilities", "pdf", "--pdf-bindings", "--only", "PDF-06"]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("not the kit's datum-host-check-pdf");
  });

  it("PDF-06 fails when a route's reply names another route's theme", async () => {
    const faults = routed();
    faults.bindings!.themeHeaders = { "datum-security-suite": "datum-pdf", "datum-security-suite-b": "datum-pdf" };
    const result = await run(["--endpoint", await pdfHost(faults), "--capabilities", "pdf", "--pdf-bindings", "--only", "PDF-06"]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toMatch(/FAIL PDF-06/);
    expect(result.out).toContain("X-Datum-Pdf-Theme of datum-security-suite-b");
  });

  it("PDF-06 fails when both routes resolve to one PDF theme, so it proves nothing", async () => {
    const faults = routed();
    faults.bindings!.routes = {};
    const result = await run(["--endpoint", await pdfHost(faults), "--capabilities", "pdf", "--pdf-bindings", "--only", "PDF-06"]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("both routes resolve to the PDF theme datum-pdf");
  });

  it("PDF-06 fails when host.json publishes no bindings table", async () => {
    const result = await run(["--endpoint", await pdfHost(), "--capabilities", "pdf", "--pdf-bindings", "--only", "PDF-06"]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toMatch(/FAIL PDF-06/);
  });

  it("fails PDF-05 when the posted answers are not sealed with the test certificate", async () => {
    const result = await run(["--endpoint", await pdfHost({ unsealed: true }), "--capabilities", "pdf", "--pdf-signing", "--only", "PDF-05"]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toMatch(/FAIL PDF-05/);
  });

  it("fails on a 500 from the print route (the never-5xx rule)", async () => {
    const result = await run(["--endpoint", await pdfHost({ server500: true }), "--capabilities", "pdf", "--only", "PDF-01"]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toMatch(/FAIL PDF-01/);
  });
});
