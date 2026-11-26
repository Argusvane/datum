/**
 * What a WebAuthn ceremony refused, as a code a page can word. The platform
 * reports through `DOMException` names; these are the ones a person can act on.
 */

export type WebAuthnErrorCode =
  /** The prompt was dismissed, timed out, or could not open (no user activation, no matching credential). */
  | "cancelled"
  /** This browser or device has no WebAuthn, or not the feature asked for. */
  | "unsupported"
  /** The relying party id does not match the page's origin, or the page is not a secure context. */
  | "security"
  /** The authenticator already holds a credential for this user (registration only). */
  | "in_use"
  /** The ceremony was aborted through its signal. */
  | "aborted"
  /** No credential is registered to sign with. */
  | "no_credentials"
  /** The response could not be read as WebAuthn's JSON and bytes. */
  | "protocol"
  /** The assertion did not verify: the reason names the check that failed. */
  | "invalid";

export class WebAuthnError extends Error {
  public readonly code: WebAuthnErrorCode;
  public readonly cause: unknown;

  constructor(code: WebAuthnErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "WebAuthnError";
    this.code = code;
    this.cause = cause;
  }
}

/** Maps what `navigator.credentials` threw to a {@link WebAuthnError}; a `WebAuthnError` passes through. */
export function toWebAuthnError(error: unknown, ceremony: "registration" | "assertion"): WebAuthnError {
  if (error instanceof WebAuthnError) {
    return error;
  }
  const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
  const message = error instanceof Error ? error.message : String(error);
  switch (name) {
    case "NotAllowedError":
      return new WebAuthnError("cancelled", ceremony === "registration" ? "The registration prompt was dismissed, timed out, or could not open." : "The signing prompt was dismissed, timed out, or could not open.", error);
    case "InvalidStateError":
      return new WebAuthnError("in_use", "This authenticator already holds a credential for this user.", error);
    case "NotSupportedError":
      return new WebAuthnError("unsupported", "This browser or authenticator does not support what was asked for.", error);
    case "SecurityError":
      return new WebAuthnError("security", "The relying party id does not match this page's origin, or the page is not a secure context.", error);
    case "AbortError":
      return new WebAuthnError("aborted", "The ceremony was aborted.", error);
    case "ConstraintError":
      return new WebAuthnError("unsupported", "The authenticator cannot meet the user-verification or resident-key requirement asked for.", error);
    default:
      return new WebAuthnError("protocol", message || "WebAuthn failed.", error);
  }
}

/** Words a WebAuthn failure for the person in front of the page. */
export function describeWebAuthnError(error: unknown): string {
  const known = error instanceof WebAuthnError ? error : toWebAuthnError(error, "assertion");
  switch (known.code) {
    case "cancelled":
      return `${known.message} Try again right after clicking, and keep the security key in reach.`;
    case "unsupported":
      return `${known.message} A passkey-capable browser and a platform or roaming authenticator are needed.`;
    case "security":
      return `${known.message} The relying party id must be this page's host, or a registrable suffix of it.`;
    case "in_use":
      return `${known.message} Use another token, or delete the existing registration first.`;
    case "no_credentials":
      return known.message;
    case "invalid":
      return `The signature did not verify: ${known.message}`;
    default:
      return known.message;
  }
}
