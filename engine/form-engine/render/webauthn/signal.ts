/**
 * The WebAuthn Signal API (Chrome/Edge 132+, Safari 26): a relying party tells the passkey
 * provider what it no longer holds, so stale passkeys leave the picker — what "evict" means
 * for a relying party's page. Absent statics are reported, never thrown: Firefox
 * has none, and the local record goes either way.
 */

export type SignalOutcome = "signalled" | "unsupported";

interface SignalStatics {
  signalUnknownCredential?: (options: { rpId: string; credentialId: string }) => Promise<void>;
  signalAllAcceptedCredentials?: (options: { rpId: string; userId: string; allAcceptedCredentialIds: string[] }) => Promise<void>;
  signalCurrentUserDetails?: (options: { rpId: string; userId: string; name: string; displayName: string }) => Promise<void>;
}

function statics(): SignalStatics {
  return ((globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential ?? {}) as SignalStatics;
}

/** A credential id (base64url) the relying party no longer knows. */
export async function signalUnknownCredential(options: { rpId: string; credentialId: string }): Promise<SignalOutcome> {
  const api = statics();
  if (typeof api.signalUnknownCredential !== "function") {
    return "unsupported";
  }
  await api.signalUnknownCredential(options);
  return "signalled";
}

/** The full list of credential ids (base64url) the relying party still accepts for a user (base64url id). */
export async function signalAllAcceptedCredentials(options: { rpId: string; userId: string; allAcceptedCredentialIds: string[] }): Promise<SignalOutcome> {
  const api = statics();
  if (typeof api.signalAllAcceptedCredentials !== "function") {
    return "unsupported";
  }
  await api.signalAllAcceptedCredentials(options);
  return "signalled";
}

/** The user's current name and display name, so the provider's labels follow the relying party's. */
export async function signalCurrentUserDetails(options: { rpId: string; userId: string; name: string; displayName: string }): Promise<SignalOutcome> {
  const api = statics();
  if (typeof api.signalCurrentUserDetails !== "function") {
    return "unsupported";
  }
  await api.signalCurrentUserDetails(options);
  return "signalled";
}

/** Whether this browser has the Signal API at all. */
export function signalApiAvailable(): boolean {
  return typeof statics().signalUnknownCredential === "function";
}
