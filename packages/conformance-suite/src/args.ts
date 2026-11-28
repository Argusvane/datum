import { DEFAULT_ABI_FLOOR } from "./version.js";

export type Subcommand = "run" | "list" | "explain" | "fixture" | "builder-cleanup" | "help" | "version";

export interface CliOptions {
  command: Subcommand;
  /** `explain <id>`. */
  target?: string;
  json: boolean;
  fixtureFormat: "json" | "submissions";
  program?: string;
  /** `--qjs-wasm <file>`: run the program on the server hosts' engine, this `qjs-wasi.wasm`, held to `--qjs-sha256`. */
  qjsWasm?: string;
  qjsSha256?: string;
  manifest?: string;
  abiFloor: string;
  budgetProfile: "node" | "browser";
  golden?: string;
  plugins: string[];
  endpoint?: string;
  form?: string;
  formVersion: string;
  parity: boolean;
  /** `--pdf-program <file>`: run the PDF output vectors (OUT) against this PDF program; `--pdf` uses the default one. */
  pdfProgram?: string;
  pdf: boolean;
  all: boolean;
  only: string[];
  skip: string[];
  gate: "release" | "full";
  failOn: "fail" | "warn";
  heavy: boolean;
  formats: ("json" | "md")[];
  out?: string;
  quiet: boolean;
  /** The endpoint flags given, by name (they need `--endpoint`). */
  endpointFlags: string[];
  /** Header lines `Name: value` from `--auth-header` and `--header` (repeatable), and the `--cookie` value. Never printed. */
  headers: string[];
  cookie?: string;
  publicDefinitionUrl?: string;
  allowWrites: boolean;
  fixtureAcknowledged: boolean;
  bodyLimit: number;
  maxRequests: number;
  delayMs: number;
  timeoutMs: number;
  /** `--builder`: the builder profile (a host's definition-saving endpoint) instead of the receiving one. */
  builder: boolean;
  builderForm?: string;
  stateFile: string;
  definitionLimit: number;
  dryRun: boolean;
  /** Only set when `--max-saves` is given; the builder default (60) applies otherwise. */
  maxSaves?: number;
  /** The builder-only flags given, by name (they need `--builder`). */
  builderFlags: string[];
  argv: string[];
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const VALUE_FLAGS = new Set([
  "--program",
  "--pdf-program",
  "--qjs-wasm",
  "--qjs-sha256",
  "--manifest",
  "--abi-floor",
  "--budget-profile",
  "--golden",
  "--plugins",
  "--endpoint",
  "--form",
  "--form-version",
  "--auth-header",
  "--cookie",
  "--header",
  "--body-limit",
  "--max-requests",
  "--delay-ms",
  "--timeout-ms",
  "--public-definition-url",
  "--only",
  "--skip",
  "--gate",
  "--fail-on",
  "--format",
  "--out",
  "--builder-form",
  "--state-file",
  "--definition-limit",
  "--max-saves"
]);
const BUILDER_ONLY = new Set(["--builder-form", "--state-file", "--definition-limit", "--max-saves", "--dry-run"]);
const BOOLEAN_FLAGS = new Set(["--pdf", "--parity", "--all", "--heavy", "--quiet", "--allow-writes", "--i-installed-the-suite-fixture", "--json", "--help", "-h", "--version", "--builder", "--dry-run"]);
const ENDPOINT_ONLY = new Set([
  "--auth-header",
  "--cookie",
  "--header",
  "--body-limit",
  "--max-requests",
  "--delay-ms",
  "--timeout-ms",
  "--public-definition-url",
  "--allow-writes",
  "--i-installed-the-suite-fixture",
  "--form",
  "--form-version"
]);

export const USAGE = `datum-security-check: a conformance suite for Datum's validation gate

Usage
  datum-security-check --program <file> [--manifest <manifest.json>] [--abi-floor ${DEFAULT_ABI_FLOOR}] [--budget-profile node|browser]
                       [--qjs-wasm <qjs-wasi.wasm> --qjs-sha256 <hex>]
                                                 the program runs on quickjs-emscripten (the browser and Node hosts' engine), or with
                                                 --qjs-wasm on quickjs-ng's qjs-wasi.wasm as the server hosts run it, once it
                                                 matches the pinned sha256
  datum-security-check --endpoint <url> --form <id> [--form-version 1] [--auth-header "Name: value"]
                       [--allow-writes] [--heavy] [--body-limit N] [--max-requests N] [--delay-ms N] [--timeout-ms N]
                       [--public-definition-url <url>] [--i-installed-the-suite-fixture]
  datum-security-check --parity [--program <file>]                                                          kernel-versus-program parity (PAR vectors)
  datum-security-check --all <...>                program + parity (+ endpoint when given)
  datum-security-check --pdf-program <datum-pdf.program.js>  PDF output safety (OUT vectors): renders hostile answers and inspects the bytes
                       (--pdf alone uses packages/pdf-kernel/dist/datum-pdf.program.js; combines with --program, --parity, --all)

  datum-security-check --endpoint <url> --builder --allow-writes [--cookie "SESS...=..."]
                       [--builder-form <id>] [--state-file <path>] [--definition-limit <bytes>]
                       [--max-saves N] [--dry-run] [--heavy] [--i-installed-the-suite-fixture]
                                                 the builder profile: creates a form of its own, saves hostile definitions into it, deletes it
  datum-security-check builder-cleanup --endpoint <url> [--state-file <path>] [--cookie ...]    removes what a killed builder run left

Common options
  --only <ids|classes>     run only these vectors (ids such as ISO-03, classes such as isolation or ISO)
  --skip <ids|classes>     leave these out
  --gate release|full      release (default) runs enforced and advisory vectors; full also runs pending and heavy ones
  --fail-on fail|warn      exit 1 on an enforced FAIL (default), or also on WARN and XPASS
  --format json,md         report formats (default md)
  --out <dir|->            write report.json / report.md into a folder, or print to stdout with "-"
  --golden <file>          judge against this golden file instead of the bundled one
  --plugins <module.js>    register this plugin module in every sandbox (repeatable)
  --quiet                  print nothing but errors

Subcommands
  list [--json]            the vector catalogue
  explain <id>             one vector: what it sends, what it expects, where it comes from
  fixture [--format json|submissions]  the fixture form an endpoint run installs (json: the definition; submissions: the body of POST /api/forms)

Exit codes
  0 PASS   1 an enforced vector FAILed   2 usage or configuration error   3 INCONCLUSIVE   4 internal error
`;

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    command: "run",
    json: false,
    fixtureFormat: "json",
    abiFloor: DEFAULT_ABI_FLOOR,
    budgetProfile: "node",
    plugins: [],
    formVersion: "1",
    parity: false,
    pdf: false,
    all: false,
    only: [],
    skip: [],
    gate: "release",
    failOn: "fail",
    heavy: false,
    formats: ["md"],
    quiet: false,
    endpointFlags: [],
    headers: [],
    allowWrites: false,
    fixtureAcknowledged: false,
    bodyLimit: 1_048_576,
    maxRequests: 400,
    delayMs: 250,
    timeoutMs: 30_000,
    builder: false,
    stateFile: "./.datum-security-run.json",
    definitionLimit: 8 * 1024 * 1024,
    dryRun: false,
    builderFlags: [],
    argv: [...argv]
  };
  const args = [...argv];
  const first = args[0];
  if (first === "list" || first === "explain" || first === "fixture" || first === "builder-cleanup") {
    options.command = first;
    args.shift();
    if (first === "explain") {
      const target = args.shift();
      if (target === undefined || target.startsWith("-")) {
        throw new UsageError("explain needs a vector id, for example: explain ISO-03");
      }
      options.target = target;
    }
  }
  for (let at = 0; at < args.length; at += 1) {
    const raw = args[at] as string;
    let flag = raw;
    let inline: string | undefined;
    const equals = raw.startsWith("--") ? raw.indexOf("=") : -1;
    if (equals > 0) {
      flag = raw.slice(0, equals);
      inline = raw.slice(equals + 1);
    }
    if (!flag.startsWith("-")) {
      throw new UsageError(`unexpected argument "${raw}"`);
    }
    if (!VALUE_FLAGS.has(flag) && !BOOLEAN_FLAGS.has(flag)) {
      throw new UsageError(`unknown option ${flag}`);
    }
    let value: string | undefined;
    if (VALUE_FLAGS.has(flag)) {
      value = inline ?? args[at + 1];
      if (value === undefined || (inline === undefined && value.startsWith("--"))) {
        throw new UsageError(`${flag} needs a value`);
      }
      if (inline === undefined) {
        at += 1;
      }
    } else if (inline !== undefined) {
      throw new UsageError(`${flag} takes no value`);
    }
    if (ENDPOINT_ONLY.has(flag)) {
      options.endpointFlags.push(flag);
    }
    if (BUILDER_ONLY.has(flag)) {
      options.builderFlags.push(flag);
    }
    switch (flag) {
      case "--program":
        options.program = value as string;
        break;
      case "--qjs-wasm":
        options.qjsWasm = value as string;
        break;
      case "--qjs-sha256":
        if (!/^[0-9a-f]{64}$/.test(value as string)) {
          throw new UsageError(`--qjs-sha256 is 64 lower-case hex characters, not "${value}"`);
        }
        options.qjsSha256 = value as string;
        break;
      case "--pdf-program":
        options.pdfProgram = value as string;
        options.pdf = true;
        break;
      case "--pdf":
        options.pdf = true;
        break;
      case "--manifest":
        options.manifest = value as string;
        break;
      case "--abi-floor":
        if (!/^\d+\.\d+\.\d+$/.test(value as string)) {
          throw new UsageError(`--abi-floor must look like ${DEFAULT_ABI_FLOOR}, not "${value}"`);
        }
        if (!abiFloorHolds(value as string)) {
          throw new UsageError(`--abi-floor must be ${DEFAULT_ABI_FLOOR} or a later version of its major, not "${value}"`);
        }
        options.abiFloor = value as string;
        break;
      case "--budget-profile":
        if (value !== "node" && value !== "browser") {
          throw new UsageError(`--budget-profile is node or browser, not "${value}"`);
        }
        options.budgetProfile = value;
        break;
      case "--golden":
        options.golden = value as string;
        break;
      case "--plugins":
        options.plugins.push(value as string);
        break;
      case "--endpoint":
        options.endpoint = value as string;
        break;
      case "--form":
        options.form = value as string;
        break;
      case "--form-version":
        options.formVersion = value as string;
        break;
      case "--only":
        options.only.push(...splitList(value as string));
        break;
      case "--skip":
        options.skip.push(...splitList(value as string));
        break;
      case "--gate":
        if (value !== "release" && value !== "full") {
          throw new UsageError(`--gate is release or full, not "${value}"`);
        }
        options.gate = value;
        break;
      case "--fail-on":
        if (value !== "fail" && value !== "warn") {
          throw new UsageError(`--fail-on is fail or warn, not "${value}"`);
        }
        options.failOn = value;
        break;
      case "--format": {
        if (options.command === "fixture") {
          if (value !== "json" && value !== "submissions") {
            throw new UsageError(`fixture --format is json or submissions, not "${value}"`);
          }
          options.fixtureFormat = value;
          break;
        }
        const formats = splitList(value as string);
        if (formats.length === 0 || formats.some((format) => format !== "json" && format !== "md")) {
          throw new UsageError(`--format is json, md or json,md, not "${value}"`);
        }
        options.formats = [...new Set(formats)] as ("json" | "md")[];
        break;
      }
      case "--out":
        options.out = value as string;
        break;
      case "--auth-header":
      case "--header":
        if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+\s*:/.test(value as string)) {
          throw new UsageError(`${flag} is a header line "Name: value", not "${(value as string).split(":")[0]}"`);
        }
        options.headers.push(value as string);
        break;
      case "--cookie":
        options.cookie = value as string;
        break;
      case "--public-definition-url":
        options.publicDefinitionUrl = value as string;
        break;
      case "--allow-writes":
        options.allowWrites = true;
        break;
      case "--i-installed-the-suite-fixture":
        options.fixtureAcknowledged = true;
        break;
      case "--body-limit":
      case "--max-requests":
      case "--delay-ms":
      case "--timeout-ms": {
        const number = Number(value);
        const least = flag === "--delay-ms" ? 0 : 1;
        if (!Number.isInteger(number) || number < least) {
          throw new UsageError(`${flag} is a whole number of at least ${least}, not "${value}"`);
        }
        options[flag === "--body-limit" ? "bodyLimit" : flag === "--max-requests" ? "maxRequests" : flag === "--delay-ms" ? "delayMs" : "timeoutMs"] = number;
        break;
      }
      case "--builder":
        options.builder = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--builder-form":
        options.builderForm = value as string;
        break;
      case "--state-file":
        options.stateFile = value as string;
        break;
      case "--definition-limit":
      case "--max-saves": {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1) {
          throw new UsageError(`${flag} is a whole number of at least 1, not "${value}"`);
        }
        if (flag === "--max-saves") {
          options.maxSaves = number;
        } else {
          options.definitionLimit = number;
        }
        break;
      }
      case "--parity":
        options.parity = true;
        break;
      case "--all":
        options.all = true;
        break;
      case "--heavy":
        options.heavy = true;
        break;
      case "--quiet":
        options.quiet = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.command = "help";
        break;
      case "--version":
        options.command = "version";
        break;
      default:
        break;
    }
  }
  return options;
}

function splitList(value: string): string[] {
  return value.split(",").map((part) => part.trim()).filter((part) => part !== "");
}

/** Whether a floor is the suite's own or a later version of the same major. */
function abiFloorHolds(floor: string): boolean {
  const [major, minor, patch] = floor.split(".").map(Number) as [number, number, number];
  const [baseMajor, baseMinor, basePatch] = DEFAULT_ABI_FLOOR.split(".").map(Number) as [number, number, number];
  return major === baseMajor && (minor > baseMinor || (minor === baseMinor && patch >= basePatch));
}
