import { describe, expect, it } from "vitest";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { PdfGeneratedLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import type { RenderableRuntime } from "../form-engine/render/core/runtime-render-bridge.js";
import type { PdfKernelRequest } from "../form-engine/render/pdf/pdf-abi.js";
import type { PdfRenderProvider } from "../form-engine/render/pdf/pdf-provider.js";
import { renderFormPdf } from "../form-engine/render/pdf/pdf-service.js";
import {
  DEFAULT_PDF_SIGNING_AGENT_URL,
  PdfSigningAgentError,
  agentPdfSignerFor,
  createAgentPdfSigner,
  listAgentCertificates,
  type PdfSigningAgentCertificate
} from "../form-engine/render/pdf/pdf-agent-signer.js";

const SIGNATURE_SLOT: PdfSigningAgentCertificate = {
  slot: "9c",
  slotName: "SIGNATURE",
  subject: "CN=Ada Lovelace,O=Datum",
  subjectCommonName: "Ada Lovelace",
  issuer: "CN=Ada Lovelace,O=Datum",
  serialNumber: "1234abcd",
  notBefore: "2026-01-01T00:00:00Z",
  notAfter: "2126-01-01T00:00:00Z",
  keyType: "RSA2048",
  algorithm: "RSASSA-PKCS1-v1_5-SHA256",
  pinPolicy: "always",
  touchPolicy: "cached",
  usable: true,
  certificates: ["Y2VydA==", "aXNzdWVy"]
};
const AUTH_SLOT: PdfSigningAgentCertificate = {
  ...SIGNATURE_SLOT,
  slot: "9a",
  slotName: "AUTHENTICATION",
  keyType: "RSA1024",
  algorithm: null,
  usable: false,
  unusableReason: "RSA-1024: the PDF kernel refuses signature values under 128 bytes",
  certificates: ["c21hbGw="]
};
const FILE_ENTRY: PdfSigningAgentCertificate = {
  ...SIGNATURE_SLOT,
  slot: "file",
  slotName: "FILE",
  source: "file",
  file: "signer.p12",
  subjectCommonName: "Ada Lovelace (file)",
  pinPolicy: "passphrase",
  touchPolicy: "never",
  certificates: ["ZmlsZQ=="]
};
const INVENTORY = { agent: { name: "datum-piv-agent", version: "0.1.0" }, devices: [{ serial: 1, name: "YubiKey", version: "5.7.1" }], certificates: [SIGNATURE_SLOT, AUTH_SLOT] };

type Call = { url: string; init: RequestInit | undefined };

/** A fetch that answers the agent's two routes from a script, recording what it was asked. */
function agentFetch(answers: { certificates?: unknown; sign?: unknown; status?: { certificates?: number; sign?: number }; reject?: boolean; raw?: string } = {}) {
  const calls: Call[] = [];
  const doFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (answers.reject) {
      throw new TypeError("Failed to fetch");
    }
    if (answers.raw !== undefined) {
      return new Response(answers.raw, { status: 502, headers: { "Content-Type": "text/html" } });
    }
    const route = url.endsWith("/certificates") ? "certificates" : "sign";
    const body = route === "certificates" ? (answers.certificates ?? INVENTORY) : (answers.sign ?? { slot: "9c", algorithm: "RSASSA-PKCS1-v1_5-SHA256", keyType: "RSA2048", value: "c2lnbmVk" });
    const status = answers.status?.[route] ?? 200;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetch: doFetch, calls };
}

describe("listAgentCertificates", () => {
  it("lists the token through GET /certificates at the default URL", async () => {
    const agent = agentFetch();
    const inventory = await listAgentCertificates(undefined, { fetch: agent.fetch });
    expect(inventory.certificates.map((entry) => entry.slot)).toEqual(["9c", "9a"]);
    expect(inventory.agent.name).toBe("datum-piv-agent");
    expect(agent.calls[0]?.url).toBe(`${DEFAULT_PDF_SIGNING_AGENT_URL}/certificates`);
    expect(agent.calls[0]?.init?.method).toBe("GET");
  });

  it("strips a trailing slash from the URL and tolerates a listing without devices", async () => {
    const agent = agentFetch({ certificates: { certificates: [] } });
    const inventory = await listAgentCertificates("http://127.0.0.1:9999/", { fetch: agent.fetch });
    expect(inventory).toEqual({ agent: { name: "unknown", version: "unknown" }, devices: [], certificates: [] });
    expect(agent.calls[0]?.url).toBe("http://127.0.0.1:9999/certificates");
  });

  it("names what went wrong: nothing listening, a non-agent answer, or the agent's own code", async () => {
    await expect(listAgentCertificates(undefined, { fetch: agentFetch({ reject: true }).fetch })).rejects.toMatchObject({ name: "PdfSigningAgentError", code: "unreachable" });
    await expect(listAgentCertificates(undefined, { fetch: agentFetch({ raw: "<html>proxy</html>" }).fetch })).rejects.toMatchObject({ code: "protocol", status: 502 });
    await expect(listAgentCertificates(undefined, { fetch: agentFetch({ certificates: { error: { code: "no_device", message: "No YubiKey is plugged in" } }, status: { certificates: 503 } }).fetch })).rejects.toMatchObject({
      code: "no_device",
      status: 503,
      message: "No YubiKey is plugged in"
    });
    await expect(listAgentCertificates(undefined, { fetch: agentFetch({ certificates: { error: { code: "made_up" } }, status: { certificates: 500 } }).fetch })).rejects.toMatchObject({ code: "protocol" });
    await expect(listAgentCertificates(undefined, { fetch: agentFetch({ certificates: { nope: true } }).fetch })).rejects.toMatchObject({ code: "protocol" });
  });
});

describe("agentPdfSignerFor / createAgentPdfSigner", () => {
  it("carries the listed chain and posts the bytes, the algorithm and the context to /sign", async () => {
    const agent = agentFetch();
    const signer = agentPdfSignerFor(SIGNATURE_SLOT, { url: "http://127.0.0.1:7391", context: { title: "Customer intake", field: "Signature1" }, fetch: agent.fetch });
    expect(signer.certificates).toEqual(["Y2VydA==", "aXNzdWVy"]);
    const value = await signer.sign(new Uint8Array([116, 111, 45, 98, 101]), "RSASSA-PKCS1-v1_5-SHA256");
    expect(Buffer.from(value).toString()).toBe("signed");
    const call = agent.calls[0]!;
    expect(call.url).toBe("http://127.0.0.1:7391/sign");
    expect(call.init?.method).toBe("POST");
    expect(call.init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(call.init?.body as string)).toEqual({
      slot: "9c",
      algorithm: "RSASSA-PKCS1-v1_5-SHA256",
      toBeSigned: "dG8tYmU=",
      context: { title: "Customer intake", field: "Signature1" }
    });
  });

  it("refuses an unusable slot before any request, and an algorithm the certificate does not sign with", async () => {
    const agent = agentFetch();
    expect(() => agentPdfSignerFor(AUTH_SLOT, { fetch: agent.fetch })).toThrow(PdfSigningAgentError);
    expect(() => agentPdfSignerFor(AUTH_SLOT, { fetch: agent.fetch })).toThrow(/128 bytes/);
    const signer = agentPdfSignerFor(SIGNATURE_SLOT, { fetch: agent.fetch });
    await expect(signer.sign(new Uint8Array([1]), "ECDSA-P256-SHA256")).rejects.toMatchObject({ code: "algorithm_mismatch" });
    expect(agent.calls).toEqual([]);
  });

  it("types the agent's refusals so a page can word them", async () => {
    const pin = agentFetch({ sign: { error: { code: "pin_invalid", message: "Wrong PIN", attemptsRemaining: 2 } }, status: { sign: 401 } });
    await expect(agentPdfSignerFor(SIGNATURE_SLOT, { fetch: pin.fetch }).sign(new Uint8Array([1]), "RSASSA-PKCS1-v1_5-SHA256")).rejects.toMatchObject({ code: "pin_invalid", status: 401, attemptsRemaining: 2, message: "Wrong PIN" });
    const cancelled = agentFetch({ sign: { error: { code: "pin_cancelled", message: "The PIN prompt was cancelled" } }, status: { sign: 409 } });
    await expect(agentPdfSignerFor(SIGNATURE_SLOT, { fetch: cancelled.fetch }).sign(new Uint8Array([1]), "RSASSA-PKCS1-v1_5-SHA256")).rejects.toMatchObject({ code: "pin_cancelled", attemptsRemaining: undefined });
    const gone = agentFetch({ reject: true });
    await expect(agentPdfSignerFor(SIGNATURE_SLOT, { fetch: gone.fetch }).sign(new Uint8Array([1]), "RSASSA-PKCS1-v1_5-SHA256")).rejects.toMatchObject({ code: "unreachable" });
    const empty = agentFetch({ sign: { slot: "9c", algorithm: "RSASSA-PKCS1-v1_5-SHA256" } });
    await expect(agentPdfSignerFor(SIGNATURE_SLOT, { fetch: empty.fetch }).sign(new Uint8Array([1]), "RSASSA-PKCS1-v1_5-SHA256")).rejects.toMatchObject({ code: "protocol" });
    const wrongSlot = agentFetch({ sign: { slot: "9a", algorithm: "RSASSA-PKCS1-v1_5-SHA256", value: "c2lnbmVk" } });
    await expect(agentPdfSignerFor(SIGNATURE_SLOT, { fetch: wrongSlot.fetch }).sign(new Uint8Array([1]), "RSASSA-PKCS1-v1_5-SHA256")).rejects.toMatchObject({ code: "protocol" });
  });

  it("createAgentPdfSigner lists the token and picks the slot — 9c unless told otherwise", async () => {
    const agent = agentFetch();
    const signer = await createAgentPdfSigner({ fetch: agent.fetch });
    expect(signer.certificates).toEqual(SIGNATURE_SLOT.certificates);
    await expect(createAgentPdfSigner({ slot: "9A", fetch: agent.fetch })).rejects.toMatchObject({ code: "unusable_key" });
    await expect(createAgentPdfSigner({ slot: "9e", fetch: agent.fetch })).rejects.toMatchObject({ code: "no_certificate", message: expect.stringContaining("9c, 9a") });
  });

  it("a certificate file rides through as the pseudo-slot `file`, and is the pick when it is all the agent holds", async () => {
    // The agent started with --p12 beside the token: named, the file signs like any slot.
    const both = agentFetch({ certificates: { ...INVENTORY, certificates: [SIGNATURE_SLOT, FILE_ENTRY] }, sign: { slot: "file", algorithm: "RSASSA-PKCS1-v1_5-SHA256", keyType: "RSA2048", value: "c2lnbmVk" } });
    const named = await createAgentPdfSigner({ slot: "file", fetch: both.fetch });
    expect(named.certificates).toEqual(["ZmlsZQ=="]);
    await named.sign(new Uint8Array([1]), "RSASSA-PKCS1-v1_5-SHA256");
    expect(JSON.parse(both.calls[1]?.init?.body as string)).toMatchObject({ slot: "file" });
    // Left unnamed, 9c still wins when it is there…
    expect((await createAgentPdfSigner({ fetch: both.fetch })).certificates).toEqual(SIGNATURE_SLOT.certificates);
    // …and the file is the pick when it is the one usable certificate — an agent run for a file alone.
    const alone = agentFetch({ certificates: { agent: INVENTORY.agent, devices: [{ serial: null, name: "signer.p12", version: null }], certificates: [FILE_ENTRY] } });
    expect((await createAgentPdfSigner({ fetch: alone.fetch })).certificates).toEqual(["ZmlsZQ=="]);
    // Two usable certificates and no 9c: the page has to choose.
    const several = agentFetch({ certificates: { ...INVENTORY, certificates: [{ ...SIGNATURE_SLOT, slot: "9d", slotName: "KEY_MANAGEMENT" }, FILE_ENTRY] } });
    await expect(createAgentPdfSigner({ fetch: several.fetch })).rejects.toMatchObject({ code: "no_certificate", message: expect.stringContaining("9d, file") });
  });

  it("without a fetch anywhere the signer says so", () => {
    const saved = globalThis.fetch;
    // @ts-expect-error — simulating a host without fetch
    globalThis.fetch = undefined;
    try {
      expect(() => agentPdfSignerFor(SIGNATURE_SLOT)).toThrow(/fetch is not available/);
    } finally {
      globalThis.fetch = saved;
    }
  });
});

describe("through renderFormPdf", () => {
  const HANDOFF = { field: "Signature1", byteRange: [0, 10, 20, 5] as [number, number, number, number], digest: "ZGlnZXN0", toBeSigned: "dG8tYmUtc2lnbmVk", toBeSignedDigest: "dGJzLWRpZ2VzdA==", signatureAlgorithm: "RSASSA-PKCS1-v1_5-SHA256" as const, subFilter: "ETSI.CAdES.detached" as const };

  function runtime(layout: PdfGeneratedLayout): RenderableRuntime & { state: () => FormState } {
    const form: ComponentNode = { id: "intake", type: "form", configuration: { title: "Customer intake" }, children: { body: [{ id: "name", type: "textfield", configuration: { label: "Name" } }] } } as ComponentNode;
    const state: FormState = {
      values: { name: "Ada" },
      touched: new Set(),
      dirty: new Set(),
      validation: { valid: true },
      submission: { status: "idle", attempts: 0 },
      navigation: { mode: "normal", visitedSteps: new Set(), completedSteps: new Set() },
      locale: "en"
    };
    return {
      formRoot: () => form,
      state: () => state,
      errors: () => [],
      effectiveStatesMap: () => new Map(),
      requiredMap: () => new Map(),
      componentTree: () => new ComponentTree(form),
      resolveDataSource: async () => undefined,
      pdfConfiguration: () => ({ layouts: [layout] })
    };
  }

  it("the agent's value lands in the completed PDF, and the certificates reach the kernel", async () => {
    const requests: PdfKernelRequest[] = [];
    const provider: PdfRenderProvider = {
      id: "fake",
      abiVersion: "1.0.0",
      render: async (request) => {
        requests.push(request);
        return { bytes: new Uint8Array([1]), pageCount: 1, pages: [], warnings: [], providerId: "fake", signing: HANDOFF };
      },
      complete: async (request) => {
        requests.push(request);
        return { bytes: new Uint8Array([2]), field: "Signature1", cms: "Y21z", timestamped: false, providerId: "fake" };
      }
    };
    const agent = agentFetch();
    const layout: PdfGeneratedLayout = { id: "sealed", kind: "generated", root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [] } } };
    const signer = await createAgentPdfSigner({ fetch: agent.fetch, context: { title: "Customer intake" } });
    const result = await renderFormPdf(runtime(layout), { provider, environment: { now: () => "2026-09-14T00:00:00.000Z", newDocumentId: () => "doc-1" } }, { layoutId: "sealed", signature: { signer } });
    expect([...result.bytes]).toEqual([2]);
    expect(result.signature).toEqual({ field: "Signature1", algorithm: "RSASSA-PKCS1-v1_5-SHA256", subFilter: "ETSI.CAdES.detached", certificates: ["Y2VydA==", "aXNzdWVy"], timestamped: false });
    const sign = agent.calls.find((call) => call.url.endsWith("/sign"))!;
    expect(JSON.parse(sign.init?.body as string)).toMatchObject({ slot: "9c", toBeSigned: "dG8tYmUtc2lnbmVk", context: { title: "Customer intake" } });
    const complete = requests.find((request) => request.op === "complete");
    expect(complete && complete.op === "complete" ? complete.signing.value : undefined).toBe("c2lnbmVk");
    expect(complete && complete.op === "complete" ? complete.signing.certificates : undefined).toEqual(["Y2VydA==", "aXNzdWVy"]);
  });
});
