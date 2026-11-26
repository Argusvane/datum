import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BuilderConfig } from "../../src/runners/endpoint/profiles/builder-types.js";
import type { VectorResult } from "../../src/report/model.js";

/** A builder run configuration for a local test server: no pause, a state file in a fresh temp folder. */
export function builderConfigFor(url: string, overrides: Partial<BuilderConfig> = {}): BuilderConfig {
  return {
    baseUrl: url,
    host: "submissions",
    headers: {},
    allowWrites: true,
    fixtureAcknowledged: false,
    formVersion: "1",
    stateFile: join(mkdtempSync(join(tmpdir(), "datum-sc-")), "run.json"),
    definitionLimit: 8 * 1024 * 1024,
    dryRun: false,
    heavy: false,
    gate: "full",
    only: [],
    skip: [],
    maxRequests: 400,
    maxSaves: 60,
    delayMs: 0,
    timeoutMs: 30_000,
    ...overrides
  };
}

export const statusOf = (results: readonly VectorResult[], id: string): string | undefined => results.find((result) => result.id === id)?.status;
export const rowStatuses = (results: readonly VectorResult[], id: string): Record<string, string> => Object.fromEntries((results.find((result) => result.id === id)?.variants ?? []).map((variant) => [variant.id, variant.status]));
