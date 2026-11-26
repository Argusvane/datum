import { capabilitiesOf, UnknownCapability, type Capability } from "./capabilities.js";

/**
 * The host under test (the Java kit's HostTarget and HostTck.target(Properties)): its base URL, the
 * paths it was configured with (the defaults are the hosts' defaults), what it was switched to, and
 * how a request is made as a visitor or as one of two signed-in people.
 */
export type Who = "visitor" | "person" | "other-person";

/** The Spring CookieCsrfTokenRepository recipe: the token cookie, echoed in a header on every write. */
export interface CsrfRecipe {
  cookie: string;
  header: string;
}

export interface HostTarget {
  /** `http://localhost:8080` (no trailing slash; a context path belongs here). */
  baseUrl: string;
  apiPath: string;
  assetsPath: string;
  tsaPath: string;
  webAuthnPath: string;
  builderEnabled: boolean;
  pdfSigning: boolean;
  /** The host publishes per-route bindings and has both fixture forms installed (the pdf-bindings case, PDF-06). */
  pdfBindings: boolean;
  signingForm: string | undefined;
  buildForm: string | undefined;
  /** Sent with every request. */
  headers: Record<string, string>;
  /** Sent by PERSON (the Java RequestDecorator's PERSON). */
  personHeaders: Record<string, string>;
  /** Sent by OTHER_PERSON. A visitor sends neither map. */
  otherPersonHeaders: Record<string, string>;
  csrf: CsrfRecipe | undefined;
  capabilities: Capability[];
  /** Per request, in milliseconds (the Java kit waits 120 s). */
  timeoutMs: number;
}

/** `baseUrl + apiPath + path` (HostTarget.api). */
export function api(target: HostTarget, path: string): string {
  return `${target.baseUrl}${target.apiPath}${path}`;
}

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetError";
  }
}

/** The key prefix HostTck reads (`datum.tck.base-url=...`); `--config` files use it too. */
export const PREFIX = "datum.tck.";

export const DEFAULT_TIMEOUT_MS = 120_000;

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Java's Boolean.parseBoolean: "true" in any case, everything else false. */
function parseBoolean(value: string | undefined): boolean {
  return value !== undefined && value.trim().toLowerCase() === "true";
}

/**
 * A target from `datum.tck.*` properties, as HostTck.target(Properties) reads them, plus the two
 * keys this kit adds (`datum.tck.csrf`, `datum.tck.timeout`). Properties are kept in insertion
 * order, so headers go out in the order they were given.
 */
export function targetFrom(properties: ReadonlyMap<string, string>): HostTarget {
  const get = (key: string): string | undefined => properties.get(PREFIX + key);
  const baseUrl = get("base-url");
  if (baseUrl === undefined || baseUrl.trim() === "") {
    throw new TargetError("--endpoint (datum.tck.base-url) is required");
  }
  const base = baseUrl.trim().replace(/\/$/, "");
  if (!/^https?:\/\/[^/?#]+/i.test(base)) {
    throw new TargetError(`--endpoint must be an http:// or https:// URL, not ${JSON.stringify(baseUrl)}`);
  }
  if (/^https?:\/\/[^/?#]*@/i.test(base)) {
    throw new TargetError("credentials in the endpoint URL are not accepted; pass --header or --person-header");
  }
  if (/[?#]/.test(base)) {
    throw new TargetError("the endpoint URL takes no query or fragment");
  }
  let capabilities: Capability[];
  try {
    capabilities = capabilitiesOf(get("capabilities") ?? "");
  } catch (error) {
    if (error instanceof UnknownCapability) throw new TargetError(error.message);
    throw error;
  }
  const headers: Record<string, string> = {};
  const personHeaders: Record<string, string> = {};
  const otherPersonHeaders: Record<string, string> = {};
  for (const [key, value] of properties) {
    for (const [prefix, into] of [
      [`${PREFIX}header.`, headers],
      [`${PREFIX}person.header.`, personHeaders],
      [`${PREFIX}other-person.header.`, otherPersonHeaders]
    ] as const) {
      if (key.startsWith(prefix)) {
        const name = key.slice(prefix.length);
        if (!HEADER_NAME.test(name)) throw new TargetError(`"${name}" is not a header name`);
        if (/[\r\n]/.test(value)) throw new TargetError(`the value of header ${name} holds a line break`);
        into[name] = value;
      }
    }
  }
  const path = (key: string, fallback: string, emptyAllowed = true): string => {
    const value = get(key);
    if (value === undefined) return fallback;
    if (value === "" && !emptyAllowed) {
      // HostTck lets an empty value through. Here the API and WebAuthn paths are also where the
      // never-5xx rule's "a JSON route answers JSON" half applies, and an empty one would switch that
      // half off for every reply without a word; the Spring host cannot mount them at the root anyway
      // (WebSettings.normalise turns a blank path into the default). A usage error instead.
      throw new TargetError(`datum.tck.${key} must not be empty: give the path the host mounts it under (default ${fallback})`);
    }
    if (value !== "" && !value.startsWith("/")) throw new TargetError(`datum.tck.${key} must start with "/" (${JSON.stringify(value)})`);
    return value;
  };
  const timeoutText = get("timeout");
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (timeoutText !== undefined) {
    if (!/^\d+$/.test(timeoutText.trim()) || Number(timeoutText) <= 0) throw new TargetError(`--timeout takes milliseconds > 0, not ${JSON.stringify(timeoutText)}`);
    timeoutMs = Number(timeoutText);
  }
  const blankIsUnset = (value: string | undefined): string | undefined => (value === undefined || value.trim() === "" ? undefined : value.trim());
  return {
    baseUrl: base,
    apiPath: path("api-path", "/api", false),
    assetsPath: path("assets-path", "/datum/assets"),
    tsaPath: path("tsa-path", "/tsa"),
    webAuthnPath: path("webauthn-path", "/api/webauthn", false),
    builderEnabled: parseBoolean(get("builder-enabled")),
    pdfSigning: parseBoolean(get("pdf-signing")),
    pdfBindings: parseBoolean(get("pdf-bindings")),
    signingForm: blankIsUnset(get("signing-form")),
    buildForm: blankIsUnset(get("build-form")),
    headers,
    personHeaders,
    otherPersonHeaders,
    csrf: csrfOf(get("csrf")),
    capabilities,
    timeoutMs
  };
}

/** `cookie:<cookie-name>:<header-name>` (e.g. `cookie:XSRF-TOKEN:X-XSRF-TOKEN`), or undefined when not given. */
export function csrfOf(value: string | undefined): CsrfRecipe | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const match = /^cookie:([^:\s;=,]+):([^:\s]+)$/.exec(value.trim());
  if (match === null || !HEADER_NAME.test(match[2] as string) || !HEADER_NAME.test(match[1] as string)) {
    throw new TargetError(`--csrf takes cookie:<cookie-name>:<header-name> (e.g. cookie:XSRF-TOKEN:X-XSRF-TOKEN), not ${JSON.stringify(value)}`);
  }
  return { cookie: match[1] as string, header: match[2] as string };
}

/**
 * A Java .properties text as ordered key/value pairs: `#` and `!` comments, `=`, `:` or white space
 * between key and value, a backslash at the end of a line continues it, and the escapes \t \n \r \f
 * \uXXXX and \<char>. Enough for every file HostTck's `--config` reads.
 */
export function parseProperties(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const physical = text.replace(/^﻿/, "").split(/\r\n|\r|\n/);
  for (let at = 0; at < physical.length; at += 1) {
    let line = (physical[at] as string).replace(/^[ \t\f]+/, "");
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
    while (endsInContinuation(line) && at + 1 < physical.length) {
      at += 1;
      line = line.slice(0, -1) + (physical[at] as string).replace(/^[ \t\f]+/, "");
    }
    if (endsInContinuation(line)) line = line.slice(0, -1);
    let keyEnd = 0;
    while (keyEnd < line.length) {
      const char = line[keyEnd] as string;
      if (char === "\\") {
        keyEnd += 2;
        continue;
      }
      if (char === "=" || char === ":" || char === " " || char === "\t" || char === "\f") break;
      keyEnd += 1;
    }
    const key = unescape(line.slice(0, Math.min(keyEnd, line.length)));
    let rest = line.slice(Math.min(keyEnd, line.length)).replace(/^[ \t\f]+/, "");
    if (rest.startsWith("=") || rest.startsWith(":")) rest = rest.slice(1).replace(/^[ \t\f]+/, "");
    out.set(key, unescape(rest));
  }
  return out;
}

function endsInContinuation(line: string): boolean {
  let slashes = 0;
  for (let at = line.length - 1; at >= 0 && line[at] === "\\"; at -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function unescape(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, escape: string) => {
    if (escape.startsWith("u") && escape.length === 5) return String.fromCharCode(parseInt(escape.slice(1), 16));
    switch (escape) {
      case "t":
        return "\t";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "f":
        return "\f";
      default:
        return escape;
    }
  });
}
