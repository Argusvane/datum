import { UsageError, type CliOptions } from "../../args.js";
import type { EndpointConfig } from "./endpoint-runner.js";

/**
 * The command line's endpoint flags as a run configuration. Secrets come from the flags or
 * `DATUM_SC_AUTH` (a header line); none of them is ever printed. Throws {@link UsageError} for
 * a configuration that cannot work.
 */
export function endpointConfigFrom(options: CliOptions, env: Record<string, string | undefined> = process.env): EndpointConfig {
  if (options.endpoint === undefined) {
    throw new UsageError(`${options.endpointFlags[0] ?? "an endpoint flag"} needs --endpoint <url>`);
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
    throw new UsageError("--endpoint must not carry credentials; pass --auth-header, --cookie or DATUM_SC_AUTH");
  }
  if (options.form === undefined || options.form === "") {
    throw new UsageError("--endpoint needs --form <id>: the id of the installed fixture form (`datum-security-check fixture` prints it)");
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
  if (options.cookie !== undefined) {
    headers["cookie"] = options.cookie;
  }
  for (const [flag, value] of [["--public-definition-url", options.publicDefinitionUrl]] as const) {
    if (value !== undefined) {
      try {
        const parsed = new URL(value);
        if (parsed.origin !== url.origin) {
          throw new UsageError(`${flag} must be on the same host as --endpoint (${url.origin})`);
        }
      } catch (error) {
        throw error instanceof UsageError ? error : new UsageError(`${flag} must be a URL, not "${value}"`);
      }
    }
  }
  return {
    baseUrl: options.endpoint,
    formId: options.form,
    formVersion: options.formVersion,
    headers,
    allowWrites: options.allowWrites,
    fixtureAcknowledged: options.fixtureAcknowledged,
    ...(options.publicDefinitionUrl !== undefined ? { publicDefinitionUrl: options.publicDefinitionUrl } : {}),
    bodyLimit: options.bodyLimit,
    maxRequests: options.maxRequests,
    delayMs: options.delayMs,
    timeoutMs: options.timeoutMs,
    heavy: options.heavy,
    gate: options.gate,
    only: options.only,
    skip: options.skip
  };
}
