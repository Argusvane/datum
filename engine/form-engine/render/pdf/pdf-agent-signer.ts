/**
 * A `PdfSigner` over a local signing agent: the small process on the person's own
 * computer that holds their hardware token — a YubiKey's PIV applet through `tools/piv-agent` —
 * or a certificate file they keep on that computer (PKCS#12 or PEM), listed
 * under the pseudo-slot `file`. The page renders the PDF as always; the kernel's `toBeSigned`
 * bytes go to `127.0.0.1`, the agent asks for the PIN or passphrase in the OS's own dialog and
 * signs, and the value comes back. The engine gains an HTTP client, not a crypto dependency —
 * `pdf-signer.ts` stays the shape.
 */
import { base64ToBytes, bytesToBase64 } from "../../core/schema/file-upload.js";
import type { PdfSignatureAlgorithm } from "./pdf-abi.js";
import type { PdfSigner } from "./pdf-provider.js";

/** Where `tools/piv-agent` listens unless told otherwise. */
export const DEFAULT_PDF_SIGNING_AGENT_URL = "http://127.0.0.1:7391";

/** The agent's own codes, plus the two the client adds when no agent answered as one. */
export type PdfSigningAgentErrorCode =
  | "unreachable"
  | "protocol"
  | "bad_request"
  | "origin_denied"
  | "not_found"
  | "no_device"
  | "no_certificate"
  | "unusable_key"
  | "algorithm_mismatch"
  | "pin_invalid"
  | "pin_blocked"
  | "pin_cancelled"
  | "touch_timeout"
  | "busy"
  | "device_error"
  | "too_large";

/** What the agent refused, as a code a page can word; `attemptsRemaining` comes with `pin_invalid`. */
export class PdfSigningAgentError extends Error {
  public readonly code: PdfSigningAgentErrorCode;
  public readonly status: number | undefined;
  public readonly attemptsRemaining: number | undefined;

  constructor(code: PdfSigningAgentErrorCode, message: string, details: { status?: number | undefined; attemptsRemaining?: number | undefined } = {}) {
    super(message);
    this.name = "PdfSigningAgentError";
    this.code = code;
    this.status = details.status;
    this.attemptsRemaining = details.attemptsRemaining;
  }
}

/** One certificate the agent can sign with — a slot of the token, or a file — as `GET /certificates` lists it. */
export interface PdfSigningAgentCertificate {
  /** The PIV slot, lower-case hex: `"9c"`; or `"file"` for a certificate file the agent was started with. */
  slot: string;
  /** `SIGNATURE`, `AUTHENTICATION`, `KEY_MANAGEMENT`, `CARD_AUTH`, `RETIRED1`…, or `FILE`. */
  slotName: string;
  /** Where the key lives: the token, or a certificate file. */
  source?: "yubikey" | "file" | undefined;
  /** The certificate file's name, for a `file` entry. */
  file?: string | null | undefined;
  subject: string;
  subjectCommonName: string | null;
  issuer: string;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
  /** The PIV key type: `RSA2048`, `ECCP256`, … */
  keyType: string;
  /** The algorithm the kernel will derive from the certificate, or `null` when it cannot sign a PDF. */
  algorithm: PdfSignatureAlgorithm | null;
  /** The token's PIN policy; for a file, `passphrase` when the key is encrypted and `never` when it is not. */
  pinPolicy: string | null;
  touchPolicy: string | null;
  usable: boolean;
  unusableReason?: string;
  /** DER base64, leaf first, then the issuers the agent was given. */
  certificates: string[];
}

export interface PdfSigningAgentInventory {
  agent: { name: string; version: string };
  devices: Array<{ serial: number | null; name: string; version: string | null }>;
  certificates: PdfSigningAgentCertificate[];
}

/** What the agent's PIN dialog says about the document, beside the origin it reads from the request. */
export interface PdfSigningAgentContext {
  title?: string | undefined;
  documentId?: string | undefined;
  field?: string | undefined;
  /** What the person is affirming — the signature's reason or commitment statement — shown in the PIN dialog. */
  reason?: string | undefined;
}

export interface AgentPdfSignerOptions {
  /** Defaults to {@link DEFAULT_PDF_SIGNING_AGENT_URL}. */
  url?: string | undefined;
  context?: PdfSigningAgentContext | undefined;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch | undefined;
}

export interface CreateAgentPdfSignerOptions extends AgentPdfSignerOptions {
  /**
   * The slot to sign with: `"9c"` (Digital Signature), `"file"` for the agent's certificate
   * file, … Left out, 9c when the agent lists it, else the one usable certificate it lists.
   */
  slot?: string | undefined;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function fetchFrom(options: { fetch?: typeof fetch | undefined }): FetchLike {
  const doFetch = options.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
  if (!doFetch) {
    throw new PdfSigningAgentError("unreachable", "fetch is not available here; give the signer a fetch");
  }
  return doFetch as FetchLike;
}

function baseUrl(url: string | undefined): string {
  return (url ?? DEFAULT_PDF_SIGNING_AGENT_URL).replace(/\/+$/, "");
}

const KNOWN_CODES = new Set<PdfSigningAgentErrorCode>([
  "bad_request",
  "origin_denied",
  "not_found",
  "no_device",
  "no_certificate",
  "unusable_key",
  "algorithm_mismatch",
  "pin_invalid",
  "pin_blocked",
  "pin_cancelled",
  "touch_timeout",
  "busy",
  "device_error",
  "too_large"
]);

/** One round trip: the JSON body, or a typed error for whatever went wrong on the way. */
async function agentRequest(url: string, path: string, init: RequestInit, doFetch: FetchLike): Promise<unknown> {
  let response: Response;
  try {
    response = await doFetch(url + path, init);
  } catch (error) {
    throw new PdfSigningAgentError("unreachable", `No signing agent answered at ${url} (${error instanceof Error ? error.message : String(error)})`);
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new PdfSigningAgentError("protocol", `${url}${path} answered ${response.status} with something that is not the agent's JSON`, { status: response.status });
  }
  const error = (body as { error?: { code?: unknown; message?: unknown; attemptsRemaining?: unknown } } | null)?.error;
  if (!response.ok || error) {
    const code = typeof error?.code === "string" && KNOWN_CODES.has(error.code as PdfSigningAgentErrorCode) ? (error.code as PdfSigningAgentErrorCode) : "protocol";
    const message = typeof error?.message === "string" ? error.message : `${url}${path} answered ${response.status}`;
    const attempts = typeof error?.attemptsRemaining === "number" ? error.attemptsRemaining : undefined;
    throw new PdfSigningAgentError(code, message, { status: response.status, attemptsRemaining: attempts });
  }
  return body;
}

/** Asks the agent what the token holds — for a page to list, or {@link createAgentPdfSigner} to pick from. */
export async function listAgentCertificates(url?: string, options: { fetch?: typeof fetch | undefined } = {}): Promise<PdfSigningAgentInventory> {
  const body = await agentRequest(baseUrl(url), "/certificates", { method: "GET" }, fetchFrom(options));
  const inventory = body as Partial<PdfSigningAgentInventory> | null;
  if (!inventory || !Array.isArray(inventory.certificates)) {
    throw new PdfSigningAgentError("protocol", "The agent's certificate listing has no certificates array");
  }
  return {
    agent: inventory.agent ?? { name: "unknown", version: "unknown" },
    devices: Array.isArray(inventory.devices) ? inventory.devices : [],
    certificates: inventory.certificates
  };
}

/**
 * A signer for one listed certificate. Synchronous: the kernel needs `certificates` before the
 * first `sign`, and the listing already carries them. Refuses a slot the kernel cannot use.
 */
export function agentPdfSignerFor(entry: PdfSigningAgentCertificate, options: AgentPdfSignerOptions = {}): PdfSigner {
  if (!entry.usable || !entry.algorithm) {
    throw new PdfSigningAgentError("unusable_key", entry.unusableReason ?? `The key in slot ${entry.slot} cannot sign a PDF`);
  }
  const url = baseUrl(options.url);
  const doFetch = fetchFrom(options);
  const expected = entry.algorithm;
  return {
    certificates: entry.certificates,
    async sign(toBeSigned: Uint8Array, algorithm: PdfSignatureAlgorithm): Promise<Uint8Array> {
      if (algorithm !== expected) {
        throw new PdfSigningAgentError("algorithm_mismatch", `The kernel derived ${algorithm} from the certificate, but slot ${entry.slot} signs with ${expected}`);
      }
      // The agent names the page by the request's own `Origin` header, never by a field the page fills in.
      const request = {
        slot: entry.slot,
        algorithm,
        toBeSigned: bytesToBase64(toBeSigned),
        context: { ...options.context }
      };
      const body = (await agentRequest(url, "/sign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) }, doFetch)) as {
        value?: unknown;
        slot?: unknown;
        algorithm?: unknown;
      } | null;
      if (!body || typeof body.value !== "string" || body.value === "") {
        throw new PdfSigningAgentError("protocol", "The agent answered without a signature value");
      }
      if (body.slot !== entry.slot || body.algorithm !== algorithm) {
        throw new PdfSigningAgentError("protocol", `The agent signed with slot ${String(body.slot)} / ${String(body.algorithm)}, not the ${entry.slot} / ${algorithm} asked for`);
      }
      return base64ToBytes(body.value);
    }
  };
}

/**
 * Lists what the agent holds and returns a signer for `slot` — 9c unless told otherwise; with
 * no slot named and no 9c listed, the single usable certificate (an agent run for a file alone).
 */
export async function createAgentPdfSigner(options: CreateAgentPdfSignerOptions = {}): Promise<PdfSigner> {
  const inventory = await listAgentCertificates(options.url, { fetch: options.fetch });
  const listed = inventory.certificates.map((candidate) => candidate.slot).join(", ") || "none";
  const slot = options.slot?.toLowerCase();
  let entry = inventory.certificates.find((candidate) => candidate.slot.toLowerCase() === (slot ?? "9c"));
  if (!entry && slot === undefined) {
    const usable = inventory.certificates.filter((candidate) => candidate.usable);
    if (usable.length === 1) {
      entry = usable[0];
    } else if (usable.length > 1) {
      throw new PdfSigningAgentError("no_certificate", `No slot 9c, and several certificates to choose from: name one with \`slot\` (the agent lists ${listed})`);
    }
  }
  if (!entry) {
    throw new PdfSigningAgentError("no_certificate", `Slot ${slot ?? "9c"} holds no certificate (the agent lists ${listed})`);
  }
  return agentPdfSignerFor(entry, options);
}
