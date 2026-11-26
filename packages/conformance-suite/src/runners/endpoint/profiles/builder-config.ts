import { UsageError, type CliOptions } from "../../../args.js";
import { DEFAULT_BUILDER_MAX_REQUESTS, DEFAULT_BUILDER_MAX_SAVES, type BuilderConfig } from "./builder-types.js";

/**
 * The command line's builder flags as a run configuration. Secrets come from the flags or the
 * environment (`DATUM_SC_COOKIE`, `DATUM_SC_AUTH`); none of them is ever printed. Throws
 * {@link UsageError} for a configuration that cannot work.
 */
export function builderConfigFrom(options: CliOptions, env: Record<string, string | undefined> = process.env): BuilderConfig {
  if (options.endpoint === undefined) {
    throw new UsageError("--builder needs --endpoint <url>");
  }
  let url: URL;
  try {
    url = new URL(options.endpoint);
  } catch {
    throw new UsageError(`--endpoint must be a URL such as https://example.org, not "${options.endpoint}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(`--endpoint must be an http or https URL, not "${options.endpoint}"`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new UsageError("--endpoint must not carry credentials; pass --cookie, --auth-header or DATUM_SC_COOKIE");
  }
  const headers: Record<string, string> = {};
  const lines = [...options.headers];
  const fromEnv = env["DATUM_SC_AUTH"];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    lines.push(fromEnv);
  }
  for (const line of lines) {
    const at = line.indexOf(":");
    if (at <= 0) {
      throw new UsageError("DATUM_SC_AUTH and --auth-header are header lines: Name: value");
    }
    headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  const cookie = options.cookie ?? env["DATUM_SC_COOKIE"];
  if (cookie !== undefined && cookie.trim() !== "") {
    headers["cookie"] = cookie;
  }
  if (!options.dryRun) {
    if (!options.allowWrites) {
      throw new UsageError("--builder creates, fills and deletes a form on the server: it needs --allow-writes (--dry-run prints what it would send and sends nothing)");
    }
  }
  return {
    baseUrl: options.endpoint,
    host: "submissions",
    headers,
    allowWrites: options.allowWrites,
    fixtureAcknowledged: options.fixtureAcknowledged,
    ...(options.builderForm !== undefined ? { builderForm: options.builderForm } : {}),
    formVersion: options.formVersion,
    stateFile: options.stateFile,
    definitionLimit: options.definitionLimit,
    dryRun: options.dryRun,
    heavy: options.heavy,
    gate: options.gate,
    only: options.only,
    skip: options.skip,
    maxRequests: options.endpointFlags.includes("--max-requests") ? options.maxRequests : DEFAULT_BUILDER_MAX_REQUESTS,
    maxSaves: options.maxSaves ?? DEFAULT_BUILDER_MAX_SAVES,
    delayMs: options.delayMs,
    timeoutMs: options.timeoutMs
  };
}
