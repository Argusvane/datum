/**
 * SHA-256 lives in the engine's core (the WebAuthn challenge is a hash of the canonical
 * submission); the kernel re-exports it from this path. Pure TypeScript, the same bytes on every runtime, no `crypto` needed.
 */
export { Sha256, sha256, sha256Hex } from "@argusvane/datum-engine/core";
