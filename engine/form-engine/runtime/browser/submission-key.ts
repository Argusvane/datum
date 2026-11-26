/**
 * The key one submission attempt is told apart by: a version 4 UUID the browser mints
 * when the attempt starts. A receiving service keeps a delivery once per key: the same key with
 * the same answers is a retry of that attempt, a known key with other answers is refused, and
 * two people who give the same answers are two keys, so two records. A second call that joins
 * the attempt in flight (a double click) carries the same key; the next attempt mints its own.
 *
 * `crypto.randomUUID` where the page has it; otherwise the UUID is built from
 * `crypto.getRandomValues`, which a page served over plain HTTP still has. Never from
 * `Math.random`: a key someone could guess names another person's attempt.
 */
export function mintSubmissionKey(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: <T extends ArrayBufferView>(array: T) => T } }).crypto;
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  if (cryptoApi === undefined || typeof cryptoApi.getRandomValues !== "function") {
    throw new Error("A submission key needs a source of random numbers (crypto.getRandomValues), and this environment has none.");
  }
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  // Version 4, variant 10xx (RFC 9562 section 5.4).
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
