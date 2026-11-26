import type { SignatureParticipant } from "../submission/signing.js";

/** Component type reserved for signature components in the canonical model. */
export const SIGNATURE_COMPONENT_TYPE = "signature";

/**
 * Capability marker attached to a signature component's configuration. Declares which
 * participants must sign the canonical submission when the active submission mode has
 * `sign === true`.
 */
export interface SignatureCapability {
  kind: "signature";
  participants: SignatureParticipant[];
}

export function isSignatureCapability(value: unknown): value is SignatureCapability {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "signature" &&
    Array.isArray((value as { participants?: unknown }).participants)
  );
}
