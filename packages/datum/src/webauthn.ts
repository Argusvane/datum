/**
 * WebAuthn in the browser as a module reached by dynamic import, so the bundler
 * gives it a lazy chunk (`datum-form-webauthn-*.js`, `datum-builder-webauthn-*.js`) beside the
 * bundle. `<datum-form>` only ever holds the provider objects a host passes in; the code that
 * runs a ceremony is needed once a person signs or a page verifies, and `webauthn-loader.ts`
 * fetches it then. Nothing may import this statically from the bundle's entry, and `form.ts`
 * must not re-export the ceremony code from the engine, or it rides in the bundle again.
 *
 * It is also the entry of `datum-webauthn.js`, the package's `./webauthn` subpath export (built
 * by `--mode webauthn`, one file with no chunks): an npm host that wants the real functions
 * without the lazy hop, in a page, a worker or Node, imports them from there, and gets the
 * engine's own code.
 */
export {
  COSE_ALGORITHM,
  WEBAUTHN_SIGNING_PROVIDER_ID,
  WebAuthnError,
  createWebAuthnSigningProvider,
  credentialsContainerFrom,
  describeWebAuthnError,
  ecdsaDerToP1363,
  parseAuthenticatorData,
  registerCredential,
  requestAssertion,
  signalAllAcceptedCredentials,
  signalApiAvailable,
  signalCurrentUserDetails,
  signalUnknownCredential,
  toWebAuthnError,
  verifyAssertion,
  verifyRegistration,
  verifyWebAuthnSubmission,
  webAuthnAlgorithmName,
  type AssertionVerdict,
  type AuthenticatorFlags,
  type ParsedAuthenticatorData,
  type RegisterCredentialOptions,
  type RegistrationVerdict,
  type RequestAssertionOptions,
  type SignalOutcome,
  type VerifyAssertionOptions,
  type VerifyRegistrationOptions,
  type VerifyWebAuthnSubmissionOptions,
  type WebAuthnAssertion,
  type WebAuthnCredentialRecord,
  type WebAuthnCredentialReference,
  type WebAuthnErrorCode,
  type WebAuthnRegistrationResult,
  type WebAuthnSigningProviderOptions,
  type WebAuthnSubmissionVerdict
} from "@argusvane/datum-engine";
