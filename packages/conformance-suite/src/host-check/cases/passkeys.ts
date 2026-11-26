import { hostCase, type CapabilityModule, type CaseContext, type Probe, type ProbeContext, type ProbeOutcome } from "../case.js";
import { assume, check, expectCode, expectEqual, expectStatus } from "../expect.js";
import { TransportError, type Reply } from "../http.js";
import { asBoolean, asString, isRecord, path } from "../json.js";
import { CSRF_TOKEN, REACHABLE } from "../preflight.js";
import type { Who } from "../target.js";

/**
 * PKY: the passkey endpoints' wire contract without an authenticator (the Java kit's PasskeysContract): the signing
 * block a page reads, who may ask for a registration challenge, the challenge's shape, the order of the register
 * refusals (400 passkey.bad_request, 400 passkey.challenge for a token never issued, 422 passkey.invalid for a credential
 * that does not verify, then the token is spent), a person's own list, and 404 for a passkey that is not theirs. The host
 * names a form that asks for a signature (--signing-form) and the kit makes requests as --person-header and
 * --other-person-header. The full ceremony (register, sign, replay, revoke) stays in the Spring passkeys example; the
 * Java contract asserts nothing that needs an authenticator, so neither does this port (a software authenticator is
 * not needed for these four cases, and is not built).
 */
const JSON_ACCEPT = { Accept: "application/json" };
const PASSKEY_ID = "AAAAAAAAAAAAAAAAAAAAAA";

const webauthn = (context: CaseContext, rest: string): string => `${context.target.webAuthnPath}${rest}`;

function signingForm(context: CaseContext): string {
  const form = context.target.signingForm;
  assume(form !== undefined, "the host names no form that asks for a passkey signature");
  return form;
}

function post(context: CaseContext, rest: string, json: string, who: Who): Promise<Reply> {
  return context.http.send("POST", webauthn(context, rest), { contentType: "application/json", body: json, who, headers: JSON_ACCEPT });
}

const challengeBody = (context: CaseContext): string => JSON.stringify({ form: signingForm(context), context: "submit" });

/** The WebAuthn routes are on: a router's 404 (no Datum error body) for the passkeys read means off or elsewhere. */
const PASSKEY_ROUTE: Probe = {
  id: "passkey-route",
  checks: "GET <webauthn-path>/passkeys[?form=<signing-form>] does not answer a router's 404 (the passkey routes are on)",
  async run(context: ProbeContext): Promise<ProbeOutcome> {
    const form = context.target.signingForm;
    const query = form === undefined ? "" : `?form=${encodeURIComponent(form)}`;
    let reply: Reply;
    try {
      reply = await context.probe("GET", `${context.target.baseUrl}${context.target.webAuthnPath}/passkeys${query}`, { headers: JSON_ACCEPT });
    } catch (error) {
      if (error instanceof TransportError) return { status: "missing", message: `cannot reach ${context.target.baseUrl}: ${error.message}` };
      throw error;
    }
    const code = reply.isJson() ? asString(path(reply.json(), "errors", 0, "code")) : "";
    if (reply.status === 404 && code === "") {
      return { status: "missing", message: `the passkey routes are off or elsewhere (GET ${reply.path} -> 404 without a Datum error code): switch them on for this test deployment, pass --webauthn-path, or leave passkeys out of --capabilities` };
    }
    return reply.status === 200 ? { status: "ok", message: "the passkey routes are on" } : { status: "unknown", message: `GET ${reply.path} -> ${reply.status}${code !== "" ? ` ${code}` : ""}; the cases will tell` };
  }
};

export const PASSKEYS: CapabilityModule = {
  capability: "passkeys",
  // No module-level assumption: the Java contract assumes a signing form per method (form()), and PKY-04 never needs one,
  // so with no --signing-form PKY-01..03 skip and PKY-04 still runs, as in HostTck.
  probes: [REACHABLE, CSRF_TOKEN, PASSKEY_ROUTE],
  cases: [
    hostCase({
      id: "PKY-01",
      capability: "passkeys",
      order: 1601,
      oracle: "PasskeysContract#aPageReadsTheSigningBlockAndAVisitorHasNoPasskeys",
      expects: "GET <webauthn-path>/passkeys?form=<signing-form> as a visitor -> 200 JSON with passkeys: [] and signing {mode required|optional, ready: boolean, signIn: boolean}",
      async run(context) {
        const page = await context.http.send("GET", webauthn(context, `/passkeys?form=${signingForm(context)}`), { headers: JSON_ACCEPT });
        expectStatus(page, 200);
        const body = page.json();
        const passkeys = path(body, "passkeys");
        check(Array.isArray(passkeys), () => `passkeys is not an array in ${page.text()}`);
        expectEqual(passkeys.length, 0, "a visitor's passkeys");
        const signing = path(body, "signing");
        const mode = asString(path(signing, "mode"));
        check(mode === "required" || mode === "optional", () => `signing.mode is ${JSON.stringify(mode)}, expected required or optional in ${JSON.stringify(signing)}`);
        check(typeof path(signing, "ready") === "boolean", () => `signing.ready is not a boolean in ${JSON.stringify(signing)}`);
        check(typeof path(signing, "signIn") === "boolean", () => `signing.signIn is not a boolean in ${JSON.stringify(signing)}`);
      }
    }),
    hostCase({
      id: "PKY-02",
      capability: "passkeys",
      order: 1602,
      oracle: "PasskeysContract#aVisitorMayAskForAChallengeOnlyWhereSigningNeedsNoSignIn",
      expects: "POST <webauthn-path>/challenge {form, context: submit} as a visitor -> 403 signing.sign_in when the signing block says signIn, else 200; as a person with text/plain -> 415",
      async run(context) {
        const read = await context.http.send("GET", webauthn(context, `/passkeys?form=${signingForm(context)}`), { who: "visitor" });
        const signing = path(read.json(), "signing");
        const anonymous = await post(context, "/challenge", challengeBody(context), "visitor");
        if (asBoolean(path(signing, "signIn"))) {
          expectStatus(anonymous, 403);
          expectEqual(anonymous.code(), "signing.sign_in", "the code");
        } else {
          expectStatus(anonymous, 200);
        }
        const wrongType = await context.http.send("POST", webauthn(context, "/challenge"), { contentType: "text/plain", body: challengeBody(context), who: "person" });
        expectStatus(wrongType, 415);
      }
    }),
    hostCase({
      id: "PKY-03",
      capability: "passkeys",
      order: 1603,
      oracle: "PasskeysContract#aSignedInPersonGetsAChallengeAndTheRegisterRefusalsComeInOrder",
      expects:
        "POST /challenge as a person -> 200 with challenge, token, expires, rp.id, user.id, pubKeyCredParams; POST /register with only a token -> 400 passkey.bad_request; with a credential and a token never issued -> 400 passkey.challenge; with the issued token and a forged credential -> 422 passkey.invalid; again -> 400 passkey.challenge (single use)",
      async run(context) {
        const form = signingForm(context);
        const challenge = await post(context, "/challenge", challengeBody(context), "person");
        expectStatus(challenge, 200);
        const options = challenge.json();
        for (const member of ["challenge", "token", "expires"]) {
          check(asString(path(options, member)).trim() !== "", () => `${member} is blank in ${JSON.stringify(options)}`);
        }
        check(asString(path(options, "rp", "id")).trim() !== "", () => `rp.id is blank in ${JSON.stringify(options)}`);
        check(asString(path(options, "user", "id")).trim() !== "", () => `user.id is blank in ${JSON.stringify(options)}`);
        const params = path(options, "pubKeyCredParams");
        check(Array.isArray(params) ? params.length > 0 : isRecord(params) && Object.keys(params).length > 0, () => `pubKeyCredParams is empty in ${JSON.stringify(options)}`);

        const unreadable = await post(context, "/register", JSON.stringify({ form, context: "submit", token: "x" }), "person");
        expectStatus(unreadable, 400);
        expectEqual(unreadable.code(), "passkey.bad_request", "the code of a register without a credential");

        const posted: Record<string, unknown> = {
          form,
          context: "submit",
          credential: { id: PASSKEY_ID, response: { clientDataJSON: "e30", attestationObject: "oA" } },
          token: "never-issued"
        };
        const notIssued = await post(context, "/register", JSON.stringify(posted), "person");
        expectStatus(notIssued, 400);
        expectEqual(notIssued.code(), "passkey.challenge", "the code of a token never issued");

        posted["token"] = asString(path(options, "token"));
        const forged = await post(context, "/register", JSON.stringify(posted), "person");
        expectStatus(forged, 422);
        expectEqual(forged.code(), "passkey.invalid", "the code of a credential that does not verify");
        const again = await post(context, "/register", JSON.stringify(posted), "person");
        expectStatus(again, 400, "the token is single-use");
        expectCode(again, "passkey.challenge", "the token is single-use");
      }
    }),
    hostCase({
      id: "PKY-04",
      capability: "passkeys",
      order: 1604,
      oracle: "PasskeysContract#aPersonsListIsTheirsAndAnotherPersonsPasskeyIsNotFound",
      expects: `GET <webauthn-path>/passkeys as a person -> 200 with a passkeys array; DELETE <webauthn-path>/passkeys/${PASSKEY_ID} as the other person -> 404`,
      async run(context) {
        const mine = await context.http.send("GET", webauthn(context, "/passkeys"), { who: "person", headers: JSON_ACCEPT });
        expectStatus(mine, 200);
        check(Array.isArray(path(mine.json(), "passkeys")), () => `passkeys is not an array in ${mine.text()}`);
        const notTheirs = await context.http.send("DELETE", webauthn(context, `/passkeys/${PASSKEY_ID}`), { who: "other-person", headers: JSON_ACCEPT });
        expectStatus(notTheirs, 404);
      }
    })
  ]
};
