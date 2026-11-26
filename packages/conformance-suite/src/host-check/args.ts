import { readFileSync } from "node:fs";

import { CAPABILITY_ORDER } from "./capabilities.js";
import { DEFAULT_TIMEOUT_MS, parseProperties, PREFIX } from "./target.js";

/**
 * The command line of `datum-host-check`. Every target option is an alias of one of HostTck's
 * `datum.tck.*` keys, so a `--config` file written for the Java kit works here, `datum.tck.<key>=<value>`
 * arguments are read as HostTck reads them, and the last value given for a key wins (in argument
 * order, a --config file at its place).
 */
export type HostCommand = "run" | "list" | "explain" | "fixtures" | "agent-tools" | "help" | "version";

export interface HostCheckArgs {
  command: HostCommand;
  /** `explain <id>`. */
  id?: string;
  json: boolean;
  /** `datum.tck.*` keys, in the order given. */
  properties: Map<string, string>;
  only: string[];
  skip: string[];
  out?: string;
  /** `agent-tools --tools <dump.json>`: a page's tool dump. */
  tools?: string;
  argv: string[];
}

export class HostUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostUsageError";
  }
}

const KEY_FLAGS: Readonly<Record<string, string>> = {
  "--endpoint": "base-url",
  "--capabilities": "capabilities",
  "--api-path": "api-path",
  "--assets-path": "assets-path",
  "--tsa-path": "tsa-path",
  "--webauthn-path": "webauthn-path",
  "--signing-form": "signing-form",
  "--build-form": "build-form",
  "--csrf": "csrf",
  "--timeout": "timeout"
};
const SWITCH_FLAGS: Readonly<Record<string, string>> = { "--builder-enabled": "builder-enabled", "--pdf-signing": "pdf-signing", "--pdf-bindings": "pdf-bindings" };
const HEADER_FLAGS: Readonly<Record<string, string>> = { "--header": "header.", "--person-header": "person.header.", "--other-person-header": "other-person.header." };
const OTHER_VALUE_FLAGS = new Set(["--config", "--only", "--skip", "--out", "--tools"]);

export const HOST_USAGE = `datum-host-check: the Datum host conformance kit (the wire contract every host binding answers)

Usage
  datum-host-check --endpoint <base url> --capabilities <list> [options]
  datum-host-check list [--json]           the cases, capability by capability
  datum-host-check explain <id>            one case: what it sends, what it holds the host to, its Java oracle
  datum-host-check fixtures --out <dir>    write the fixture forms, the golden file, the hostile rule module and the stale program
  datum-host-check agent-tools --tools <dump.json> [--json]
                                           compare a page's assistant tool dump (getTools() or agentTools(), as JSON) with the shipped
                                           catalogue; needs no endpoint (exit 0 no finding, 1 a finding, 2 no readable dump)

Capabilities (run in this order, flood always last)
  ${CAPABILITY_ORDER.join(", ")}

Target options (each is a datum.tck.<key> of the Java kit's HostTck; --config <file.properties> and datum.tck.<key>=<value> work too)
  --endpoint <url>                 the host's base URL, with its context path (datum.tck.base-url)
  --capabilities a,b,c             what the host serves and how it is switched (required)
  --api-path /api   --assets-path /datum/assets   --tsa-path /tsa   --webauthn-path /api/webauthn
                                   (the API and WebAuthn paths may not be empty)
  --builder-enabled                the host serves the builder's files (datum.builder.enabled)
  --pdf-signing                    the host holds a PDF signing key (else the seal cases are skipped)
  --pdf-bindings                   the host routes datum-security-suite-b to a binding whose PDF theme is the kit's
                                   datum-host-check-pdf (fixture-pdf-theme.json) and datum-security-suite to one with
                                   another (datum.bindings.*), both installed (else PDF-06 is skipped)
  --signing-form <key>             a form whose passkey signature is required (passkeys)
  --build-form <key>               a form the builder cases may read and save as the person (builder)
  --header Name=Value              on every request (repeatable)
  --person-header Name=Value       on the signed-in person's requests (repeatable)
  --other-person-header Name=Value on another signed-in person's requests (repeatable); a visitor sends neither
  --csrf cookie:<cookie>:<header>  the cookie-token CSRF recipe (Spring Boot: cookie:XSRF-TOKEN:X-XSRF-TOKEN): each
                                   person's token is fetched with GET / when none came yet, sent back as the only
                                   jar cookie, and echoed in the header on every write; a host that sets no such
                                   cookie on GET / makes the run inconclusive (exit 3)
  --timeout <ms>                   per request (default ${DEFAULT_TIMEOUT_MS})

Run options
  --only <ids>   --skip <ids>      case ids, comma separated (SUB-01,FRM-02)
  --out <dir>                      write report.json and report.md there

Exit codes
  0 every selected case passed and every named capability had a case pass   1 a case failed
  2 usage error, or a named capability asserted nothing   3 inconclusive (preflight: the host, the fixture form or a switch is missing)
  4 internal error
`;

export function parseHostArgs(argv: readonly string[]): HostCheckArgs {
  const args: HostCheckArgs = { command: "run", json: false, properties: new Map(), only: [], skip: [], argv: [...argv] };
  const rest = [...argv];
  const first = rest[0];
  if (first === "list" || first === "explain" || first === "fixtures" || first === "agent-tools") {
    args.command = first;
    rest.shift();
    if (first === "explain") {
      const id = rest.shift();
      if (id === undefined || id.startsWith("-")) throw new HostUsageError("explain takes a case id (explain SUB-01)");
      args.id = id;
    }
  } else if (first === "help") {
    args.command = "help";
    return args;
  }
  for (let at = 0; at < rest.length; at += 1) {
    const raw = rest[at] as string;
    const equals = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = equals > 0 ? raw.slice(0, equals) : raw;
    const inline = equals > 0 ? raw.slice(equals + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = rest[at + 1];
      if (next === undefined || (next.startsWith("--") && next.length > 2)) throw new HostUsageError(`${flag} needs a value`);
      at += 1;
      return next;
    };
    if (flag === "--help" || flag === "-h") {
      args.command = "help";
      return args;
    }
    if (flag === "--version") {
      args.command = "version";
      return args;
    }
    if (flag === "--json") {
      args.json = true;
      continue;
    }
    const key = KEY_FLAGS[flag];
    if (key !== undefined) {
      args.properties.set(PREFIX + key, value());
      continue;
    }
    const switchKey = SWITCH_FLAGS[flag];
    if (switchKey !== undefined) {
      if (inline !== undefined && !/^(true|false)$/i.test(inline)) throw new HostUsageError(`${flag} takes no value, or =true / =false`);
      args.properties.set(PREFIX + switchKey, inline ?? "true");
      continue;
    }
    const headerPrefix = HEADER_FLAGS[flag];
    if (headerPrefix !== undefined) {
      const line = value();
      const split = line.search(/[=:]/);
      if (split <= 0) throw new HostUsageError(`${flag} takes Name=Value, not ${JSON.stringify(line)}`);
      args.properties.set(`${PREFIX}${headerPrefix}${line.slice(0, split).trim()}`, line.slice(split + 1).trim());
      continue;
    }
    if (OTHER_VALUE_FLAGS.has(flag)) {
      const given = value();
      if (flag === "--config") {
        let text: string;
        try {
          text = readFileSync(given, "utf8");
        } catch (error) {
          throw new HostUsageError(`cannot read --config ${given}: ${error instanceof Error ? error.message : String(error)}`);
        }
        for (const [name, entry] of parseProperties(text)) {
          if (name.startsWith(PREFIX)) args.properties.set(name, entry);
        }
      } else if (flag === "--only") {
        args.only.push(given);
      } else if (flag === "--skip") {
        args.skip.push(given);
      } else if (flag === "--tools") {
        args.tools = given;
      } else {
        args.out = given;
      }
      continue;
    }
    if (!raw.startsWith("-") && raw.startsWith(PREFIX) && raw.includes("=")) {
      args.properties.set(raw.slice(0, raw.indexOf("=")), raw.slice(raw.indexOf("=") + 1));
      continue;
    }
    throw new HostUsageError(raw.startsWith("-") ? `unknown option ${flag}` : `not an option or a datum.tck.<key>=<value>: ${raw}`);
  }
  if (args.command === "fixtures" && args.out === undefined) throw new HostUsageError("fixtures needs --out <dir>");
  if (args.command === "agent-tools" && args.tools === undefined) throw new HostUsageError("agent-tools needs --tools <dump.json> (copy(JSON.stringify(await document.modelContext.getTools())) in DevTools, or JSON.stringify(await form.agentTools()))");
  if (args.command !== "agent-tools" && args.tools !== undefined) throw new HostUsageError("--tools belongs to the agent-tools command");
  return args;
}
