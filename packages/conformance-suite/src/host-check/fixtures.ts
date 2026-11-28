import { randomUUID } from "node:crypto";

import fixtureFormText from "../../fixtures/endpoint-fixture.definition.json?raw";
import goldenText from "../../golden/abi-1.0.json?raw";
import pdfThemeText from "./fixtures/fixture-pdf-theme.json?raw";
import hardeningRulesText from "./fixtures/hardening-rules.js?raw";
import hostContextFormJson from "./fixtures/host-context-form.json?raw";
import staleProgramText from "./fixtures/stale-program.js?raw";
import { asString, isRecord, path, type JsonValue } from "./json.js";

/**
 * The kit's fixture form and the answers the kernel gives for it: the port of the Java kit's
 * TckFixtures (integrations/jvm/tck/datum-host-tck). The form is the security suite's endpoint
 * fixture (fixtures/endpoint-fixture.definition.json, form `datum-security-suite` at version 1) and
 * the verdicts are its golden control vectors (golden/abi-1.0.json: CTL-01 valid, CTL-02 to CTL-04
 * refused). The Java kit reads the same two files (copied into its jar by `npm run jvm:assets`), so
 * both kits hold a host to the same bytes. The hostile rule module and the stale program live here
 * from now on (src/host-check/fixtures/); the Java kit's copies under META-INF/datum-tck/ must stay
 * equal to them (tests/host-check/fixtures.test.ts checks it while the repository is present). The host
 * context fixture is written by hand in the Java kit's resources and copied here byte for byte.
 */

/** The fixture form's id. Never renamed: hosts have it installed under this key. */
export const FORM = "datum-security-suite";

/** The fixture form's version. */
export const VERSION = "1";

/**
 * The second fixture form's id: the fixture form under another key, for the per-route binding case (PDF-06), which
 * needs two form routes on one host. It is the same definition, so the same golden verdicts hold for it.
 */
export const FORM_B = "datum-security-suite-b";

/**
 * The kit's PDF theme, for the per-route binding case (PDF-06): the host routes {@link FORM_B} to a binding whose catalog
 * PDF theme is this one, with this object as the theme it supplies. Its one setting, the text colour
 * {@link PDF_THEME_TEXT}, is what the case looks for in the PDF's content streams, so a host that names the theme in
 * its reply but prints under another fails.
 */
export const PDF_THEME_ID = "datum-host-check-pdf";

/** The text colour of {@link PDF_THEME_ID}, which no Datum PDF theme uses. */
export const PDF_THEME_TEXT = "#123456";

/**
 * The host context fixture's id and version (the `host-context` capability): `name` required, `admin_note` required and
 * shown only when `host.role = "admin"`, one journey `main` with one page `p1`. Never renamed: hosts have it installed
 * under this key.
 */
export const HOST_CONTEXT_FORM = "datum-host-context";
export const HOST_CONTEXT_VERSION = "1";

/**
 * The request header the TEST-ONLY host context provider reads (HostContextContract): present, the provider answers
 * `{"role": <its value>}` for {@link HOST_CONTEXT_FORM}; absent, it supplies no context. A deployment that takes real
 * submissions never wires such a provider: a client chooses this header.
 */
export const TEST_ROLE_HEADER = "X-Datum-Test-Role";

/** The marker of the fixture's server-secret rule, which a public copy never carries. */
export const SECRET_MARKER = "ZZSECRETZZ";

/** The answer that makes the hostile module loop forever. */
export const LOOP = "datum-tck-loop";
/** The answer that makes it take memory without bound. */
export const MEMORY = "datum-tck-memory";
/** The answer that makes it answer an error of 40 MiB. */
export const HUGE = "datum-tck-huge";
/** The answer that makes it write a forged outcome to stdout after the run's answer frame. */
export const STRAY = "datum-tck-stray";

/** The files `datum-host-check fixtures --out <dir>` writes, under the names the Java kit's jar uses. */
export const FIXTURE_FILES: readonly { name: string; text: string; what: string }[] = [
  { name: "fixture-form.json", text: fixtureFormText, what: "the fixture form (datum-security-suite, version 1): add it to the host's forms" },
  {
    name: "fixture-form-b.json",
    text: `${JSON.stringify({ ...(JSON.parse(fixtureFormText) as Record<string, unknown>), id: "datum-security-suite-b" }, null, 2)}\n`,
    what: "the fixture form under a second key (datum-security-suite-b), only for the pdf-bindings case: add it to the host's forms beside the first"
  },
  {
    name: "fixture-host-context-form.json",
    text: hostContextFormJson,
    what: `the host context fixture form (${HOST_CONTEXT_FORM}, version ${HOST_CONTEXT_VERSION}), only for the host-context capability: add it to the host's forms beside the first, in a TEST deployment that wires the test role provider`
  },
  {
    name: "fixture-pdf-theme.json",
    text: pdfThemeText,
    what: `the kit's PDF theme (${PDF_THEME_ID}, text ${PDF_THEME_TEXT}), only for the pdf-bindings case: supply it as the PDF theme of the binding datum-security-suite-b is routed to`
  },
  { name: "golden.json", text: goldenText, what: "the golden control verdicts the cases compare with (read only by the kit)" },
  {
    name: "hardening-rules.js",
    text: hardeningRulesText,
    what: "the hostile rule module for the hardening capability: register it for the fixture form in a TEST deployment only"
  },
  {
    name: "stale-program.js",
    text: staleProgramText,
    what: "a sandbox program below every host's ABI floor, for the runtime-down capability (a test deployment's sandbox program override)"
  }
];

/** The hostile rule module's source, to register for the fixture form (the hardening capability). */
export function hardeningRules(): string {
  return hardeningRulesText;
}

/** The stale sandbox program's source (ABI 0.9.0), for the runtime-down capability. */
export function staleProgram(): string {
  return staleProgramText;
}

/** The host context fixture definition's bytes as text (the Java kit's host-context-form.json, byte for byte). */
export function hostContextFormText(): string {
  return hostContextFormJson;
}

/** The kit's PDF theme object ({@link PDF_THEME_ID}), as `fixtures --out` writes it. */
export function pdfTheme(): Record<string, JsonValue> {
  return JSON.parse(pdfThemeText) as Record<string, JsonValue>;
}

/** The fixture definition's bytes as text, to copy into a host's forms location. */
export function formText(): string {
  return fixtureFormText;
}

let goldenCache: JsonValue | undefined;
let formCache: JsonValue | undefined;

/** The golden control answers (`{controls: {CTL-01: {accepted, errors, values}}}`). */
export function golden(): JsonValue {
  goldenCache ??= JSON.parse(goldenText) as JsonValue;
  return goldenCache;
}

/** The fixture form's definition, a fresh copy each call. */
export function form(): Record<string, JsonValue> {
  formCache ??= JSON.parse(fixtureFormText) as JsonValue;
  return structuredClone(formCache) as Record<string, JsonValue>;
}

/** The suite's valid answers (its `validValues()`), nested as a browser sends them; a fresh copy each call. */
export function validValues(): Record<string, JsonValue> {
  return {
    name: "Ada Lovelace",
    code: "AB1234",
    addr: { city: "Ottawa", pick: "ok" },
    tags: { x: true, y: false },
    rows: [{ sku: "s1", n: 1 }]
  };
}

export type Control = "CTL-01" | "CTL-02" | "CTL-03" | "CTL-04";

/** The answers of one control vector, as the suite's CONTROL_VALUES builds them (the key keeps its place). */
export function controlValues(control: Control): Record<string, JsonValue> {
  const values = validValues();
  switch (control) {
    case "CTL-01":
      break;
    case "CTL-02":
      values["name"] = "";
      break;
    case "CTL-03":
      values["name"] = "x".repeat(41);
      break;
    case "CTL-04":
      values["code"] = "abc";
      break;
    default:
      throw new Error(`no control ${String(control)}`);
  }
  return values;
}

/** The envelope a form posts for these values at this version (TckFixtures.envelope(version, values)). */
export function envelopeOf(version: string, values: Record<string, JsonValue>): Record<string, JsonValue> {
  return envelopeFor(FORM, version, values);
}

/** The envelope of a form of this id (the fixture form, or its copy under {@link FORM_B}). */
export function envelopeFor(formId: string, version: string, values: Record<string, JsonValue>): Record<string, JsonValue> {
  return {
    versionContext: {
      form: { id: formId, version },
      client: { runtimeVersion: "x", rendererVersion: "x", schemaVersion: "1" }
    },
    submission: { locale: "en", values }
  };
}

/** The envelope of the host context fixture (form `datum-host-context`, version 1) with these answers, journey `main` named. */
export function hostContextEnvelope(values: Record<string, JsonValue>): Record<string, JsonValue> {
  const document = envelopeFor(HOST_CONTEXT_FORM, HOST_CONTEXT_VERSION, values);
  (document["submission"] as Record<string, JsonValue>)["journey"] = { id: "main" };
  return document;
}

/** The envelope of a control vector at the fixture's version. */
export function envelope(control: Control): Record<string, JsonValue> {
  return envelopeOf(VERSION, controlValues(control));
}

/** `{document: envelope}`, the suite's body, as compact JSON text (Jackson's ObjectNode.toString()). */
export function wrapped(envelopeValue: Record<string, JsonValue>): string {
  return JSON.stringify({ document: envelopeValue });
}

/**
 * A check's body (`POST /submissions/validate`): `{document, scope}` and, for a page check, `pageId`. The route is strict:
 * a bare document, a missing or unknown scope, a page beside `journey`, a page check with no page are all 400.
 */
export function checked(document: Record<string, JsonValue>, scope: "journey" | "page", pageId?: string): string {
  return JSON.stringify({ document, scope, ...(pageId !== undefined ? { pageId } : {}) });
}

/**
 * `{document: envelope, submissionKey}`, a delivery's body, as compact JSON text: a fresh key per
 * call (one submit attempt), or the key given (a retry of that attempt sends the same).
 */
export function delivered(envelopeValue: Record<string, JsonValue>, submissionKey: string = randomUUID()): string {
  return JSON.stringify({ document: envelopeValue, submissionKey });
}

/** The golden `code@field` set of a control, sorted (the Java kit's TreeSet). */
export function goldenErrors(control: string): string[] {
  const errors = path(golden(), "controls", control, "errors");
  const out = new Set<string>();
  if (Array.isArray(errors)) {
    for (const error of errors) out.add(asString(error));
  }
  return [...out].sort();
}

/** The `code@field` set of an errors array, sorted (TckFixtures.codes). */
export function codes(errors: unknown): string[] {
  const out = new Set<string>();
  if (Array.isArray(errors)) {
    for (const error of errors) {
      out.add(`${asString(path(error, "code"))}@${asString(path(error, "field"))}`);
    }
  } else if (isRecord(errors)) {
    // Jackson iterates an object node's values; a host answering an object here gets the same reading.
    for (const error of Object.values(errors)) {
      out.add(`${asString(path(error, "code"))}@${asString(path(error, "field"))}`);
    }
  }
  return [...out].sort();
}
