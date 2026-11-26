import type { EndpointConfig } from "../../src/runners/endpoint/endpoint-runner.js";
import type { VectorResult } from "../../src/report/model.js";

/** A run configuration for a local test server: no pause between requests, generous caps. */
export function configFor(url: string, overrides: Partial<EndpointConfig> = {}): EndpointConfig {
  return {
    baseUrl: url,
    formId: "datum-security-suite",
    formVersion: "1",
    headers: {},
    allowWrites: false,
    fixtureAcknowledged: false,
    bodyLimit: 1_048_576,
    maxRequests: 2000,
    delayMs: 0,
    timeoutMs: 30_000,
    heavy: false,
    gate: "release",
    only: [],
    skip: [],
    ...overrides
  };
}

export const statusOf = (results: readonly VectorResult[], id: string): string | undefined => results.find((result) => result.id === id)?.status;

/** The results that are enforced and not PASS or SKIP: what a conforming server must not have. */
export function enforcedProblems(results: readonly VectorResult[]): string[] {
  return results.filter((result) => result.gate === "enforced" && result.status !== "PASS" && result.status !== "SKIP").map((result) => `${result.id} ${result.status}: ${result.notes ?? ""}`);
}
