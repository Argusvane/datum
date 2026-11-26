import { createHash, randomBytes } from "node:crypto";

import { hostCase, type CapabilityModule, type CaseContext, type Probe, type ProbeContext, type ProbeOutcome } from "../case.js";
import { contains, outermostTag, pkiStatus, randomNonce, timeStampRequest } from "../crypto/tsa-der.js";
import { check, expectEqual, expectHeader, expectStatus } from "../expect.js";
import { TransportError, type Reply } from "../http.js";
import { REACHABLE } from "../preflight.js";

/**
 * TSA: the RFC 3161 timestamp server (the Java kit's TsaContract), open to anonymous clients or with the client key in
 * --header: a query is granted over its digest, bytes the server cannot read are a rejection, the checks before the body
 * come in this order (403 for a browser session cookie, 415 for another type), and the certificates are public.
 * The TimeStampReq is written and the TimeStampResp read with the PDF kernel's DER module (crypto/tsa-der.ts).
 */
const QUERY = "application/timestamp-query";
const REPLY = "application/timestamp-reply";

const sha256 = (data: Uint8Array): Uint8Array => createHash("sha256").update(data).digest();

function stamp(context: CaseContext, query: Uint8Array, headers: Record<string, string> = {}): Promise<Reply> {
  return context.http.send("POST", context.target.tsaPath, { contentType: QUERY, body: query, headers });
}

/** The route is switched on: a body the TSA cannot take as text/plain is 415 before a byte is read; a router's 404 means off. */
const TSA_ROUTE: Probe = {
  id: "tsa-route",
  checks: "POST <tsa-path> with Content-Type text/plain answers 415 (the timestamp server is on), not 404",
  async run(context: ProbeContext): Promise<ProbeOutcome> {
    let reply: Reply;
    try {
      reply = await context.probe("POST", `${context.target.baseUrl}${context.target.tsaPath}`, { contentType: "text/plain", body: "x" });
    } catch (error) {
      if (error instanceof TransportError) return { status: "missing", message: `cannot reach ${context.target.baseUrl}: ${error.message}` };
      throw error;
    }
    if (reply.status === 404) {
      return { status: "missing", message: `the timestamp server is off or elsewhere (POST ${reply.path} -> 404): switch it on for this test deployment, pass --tsa-path, or leave tsa out of --capabilities` };
    }
    return reply.status === 415 ? { status: "ok", message: "the timestamp server is on" } : { status: "unknown", message: `POST ${reply.path} as text/plain -> ${reply.status}, not 415; the cases will tell` };
  }
};

export const TSA: CapabilityModule = {
  capability: "tsa",
  probes: [REACHABLE, TSA_ROUTE],
  cases: [
    hostCase({
      id: "TSA-01",
      capability: "tsa",
      order: 1501,
      oracle: "TsaContract#aQueryIsGrantedOverItsDigest",
      expects: `POST <tsa-path> ${QUERY} (a version 1 TimeStampReq over a random SHA-256 digest, a 63-bit nonce, certReq TRUE) -> 200 ${REPLY}, Cache-Control no-store, PKIStatus 0 or 1, the reply holds the digest and the nonce`,
      async run(context) {
        const digest = sha256(randomBytes(48));
        const nonce = randomNonce();
        const reply = await stamp(context, timeStampRequest(digest, nonce));
        expectStatus(reply, 200);
        expectEqual(reply.mediaType(), REPLY, "the media type");
        check(expectHeader(reply, "Cache-Control").includes("no-store"), () => `Cache-Control is ${JSON.stringify(reply.header("Cache-Control"))}, expected no-store in ${reply.describe()}`);
        const status = pkiStatus(reply.body);
        check(status === 0 || status === 1, () => `PKIStatus ${status}, expected 0 or 1 in ${reply.describe()}`);
        // The token's TSTInfo carries the digest and the nonce as sent.
        check(contains(reply.body, digest), "the token names the digest");
        check(contains(reply.body, nonce), "the token carries the nonce");
      }
    }),
    hostCase({
      id: "TSA-02",
      capability: "tsa",
      order: 1502,
      oracle: "TsaContract#bytesTheServerCannotReadAreARejection",
      expects: `POST <tsa-path> ${QUERY} with the text "not a TimeStampReq" -> 400 ${REPLY} with PKIStatus 2 (rejection)`,
      async run(context) {
        const reply = await stamp(context, new TextEncoder().encode("not a TimeStampReq"));
        expectStatus(reply, 400);
        expectEqual(reply.mediaType(), REPLY, "the media type");
        expectEqual(pkiStatus(reply.body), 2, "PKIStatus");
      }
    }),
    hostCase({
      id: "TSA-03",
      capability: "tsa",
      order: 1503,
      oracle: "TsaContract#aSessionCookieThenAnotherTypeAreRefusedBeforeTheBodyIsRead",
      expects: `POST <tsa-path> ${QUERY} with Cookie: JSESSIONID=datum-tck -> 403; POST <tsa-path> application/octet-stream -> 415`,
      async run(context) {
        const query = timeStampRequest(sha256(Uint8Array.of(1)), Uint8Array.of(10));
        const cookie = await stamp(context, query, { Cookie: "JSESSIONID=datum-tck" });
        expectStatus(cookie, 403, "a browser session cookie");
        const wrongType = await context.http.send("POST", context.target.tsaPath, { contentType: "application/octet-stream", body: query });
        expectStatus(wrongType, 415, "another content type");
      }
    }),
    hostCase({
      id: "TSA-04",
      capability: "tsa",
      order: 1504,
      oracle: "TsaContract#theCertificatesArePublic",
      expects: "GET <tsa-path>/certificates and /certificate -> 200 PEM (-----BEGIN CERTIFICATE-----); /certificate?format=der -> 200 application/pkix-cert, one DER element starting with a SEQUENCE (0x30)",
      async run(context) {
        const all = await context.http.get(`${context.target.tsaPath}/certificates`);
        expectStatus(all, 200, "certificates");
        check(all.text().includes("-----BEGIN CERTIFICATE-----"), () => `/certificates holds no PEM certificate: ${all.describe()}`);
        const chain = await context.http.get(`${context.target.tsaPath}/certificate`);
        expectStatus(chain, 200, "certificate");
        check(chain.text().includes("-----BEGIN CERTIFICATE-----"), () => `/certificate holds no PEM certificate: ${chain.describe()}`);
        const der = await context.http.get(`${context.target.tsaPath}/certificate?format=der`);
        expectStatus(der, 200, "certificate?format=der");
        expectEqual(der.mediaType(), "application/pkix-cert", "the media type");
        expectEqual(outermostTag(der.body), 0x30, "the DER certificate's outermost tag");
      }
    })
  ]
};
