/**
 * The three reports and the words, over a hand-built report. Ajv is not
 * a dependency of this package, so the schema is checked by a small validator written here for
 * the keywords the schema uses; a keyword it does not know fails loudly instead of passing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { kernelFormTestMessage } from "@argusvane/datum-engine/form-tests";
import { describe, expect, it } from "vitest";

import { renderJson } from "../src/report/json.js";
import { classNameOf, escapeXmlAttribute, escapeXmlText, renderJunit } from "../src/report/junit.js";
import { escapeMarkdown, renderMarkdown } from "../src/report/markdown.js";
import { REPORT_SCHEMA } from "../src/report/schema.js";
import {
  compactJson,
  hasWord,
  problemMessage,
  scenarioReasonMessage,
  statusWord,
  stepMessage,
  wordedCodes
} from "../src/report/words.js";
import { AWKWARD_MESSAGE, AWKWARD_NAME, SAMPLE_STARTED_AT, sampleReport } from "./helpers/sample-report.js";

// ---------------------------------------------------------------------------------------------
// A JSON Schema validator for the keywords REPORT_SCHEMA uses.

const KNOWN = new Set([
  "$schema", "$id", "$ref", "$defs", "title", "type", "enum", "const", "properties", "required", "additionalProperties",
  "items", "minimum", "pattern", "oneOf"
]);

function typeOfValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

function typeMatches(wanted: string, value: unknown): boolean {
  const actual = typeOfValue(value);
  return wanted === actual || (wanted === "number" && actual === "integer");
}

function validate(schema: Record<string, unknown>, value: unknown, root: Record<string, unknown>, at: string): string[] {
  for (const key of Object.keys(schema)) {
    if (!KNOWN.has(key)) {
      throw new Error(`The test validator does not know the keyword ${key}`);
    }
  }
  if (typeof schema["$ref"] === "string") {
    const ref = schema["$ref"];
    const prefix = "#/$defs/";
    if (!ref.startsWith(prefix)) {
      throw new Error(`Unsupported $ref ${ref}`);
    }
    const target = (root["$defs"] as Record<string, Record<string, unknown>>)[ref.slice(prefix.length)];
    if (target === undefined) {
      throw new Error(`Unresolved $ref ${ref}`);
    }
    return validate(target, value, root, at);
  }
  const errors: string[] = [];
  if (schema["oneOf"] !== undefined) {
    const branches = schema["oneOf"] as Array<Record<string, unknown>>;
    const matching = branches.filter((branch) => validate(branch, value, root, at).length === 0).length;
    if (matching !== 1) {
      errors.push(`${at}: matches ${matching} of ${branches.length} alternatives`);
    }
  }
  if ("const" in schema && schema["const"] !== value) {
    errors.push(`${at}: expected ${JSON.stringify(schema["const"])}`);
  }
  if (Array.isArray(schema["enum"]) && !(schema["enum"] as unknown[]).includes(value)) {
    errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema["enum"])}`);
  }
  if (schema["type"] !== undefined) {
    const wanted = Array.isArray(schema["type"]) ? (schema["type"] as string[]) : [schema["type"] as string];
    if (!wanted.some((name) => typeMatches(name, value))) {
      errors.push(`${at}: ${typeOfValue(value)} is not ${wanted.join(" or ")}`);
      return errors;
    }
  }
  if (typeof schema["minimum"] === "number" && typeof value === "number" && value < schema["minimum"]) {
    errors.push(`${at}: ${value} is below ${schema["minimum"]}`);
  }
  if (typeof schema["pattern"] === "string" && typeof value === "string" && !new RegExp(schema["pattern"]).test(value)) {
    errors.push(`${at}: ${JSON.stringify(value)} does not match ${schema["pattern"]}`);
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>;
    for (const key of (schema["required"] ?? []) as string[]) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) {
        errors.push(`${at}: missing ${key}`);
      }
    }
    for (const key of Object.keys(record)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        errors.push(...validate(properties[key] as Record<string, unknown>, record[key], root, `${at}.${key}`));
      } else if (schema["additionalProperties"] === false) {
        errors.push(`${at}: unexpected ${key}`);
      } else if (typeof schema["additionalProperties"] === "object") {
        errors.push(...validate(schema["additionalProperties"] as Record<string, unknown>, record[key], root, `${at}.${key}`));
      }
    }
  }
  if (Array.isArray(value) && schema["items"] !== undefined) {
    value.forEach((item, index) => errors.push(...validate(schema["items"] as Record<string, unknown>, item, root, `${at}[${index}]`)));
  }
  return errors;
}

function schemaErrors(value: unknown): string[] {
  return validate(REPORT_SCHEMA as unknown as Record<string, unknown>, value, REPORT_SCHEMA as unknown as Record<string, unknown>, "$");
}

// ---------------------------------------------------------------------------------------------
// A small XML reader: balanced tags by a stack, attributes in double quotes, entities checked.

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITY = /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;

function unescapeXml(raw: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(raw)) {
    throw new Error(`A bare ampersand in ${JSON.stringify(raw.slice(0, 60))}`);
  }
  return raw.replace(ENTITY, (_all, name: string) => {
    switch (name) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return String.fromCodePoint(name.startsWith("#x") ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10));
    }
  });
}

function parseXml(source: string): XmlNode {
  let at = 0;
  if (source.startsWith("<?xml")) {
    at = source.indexOf("?>") + 2;
  }
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  while (at < source.length) {
    const open = source.indexOf("<", at);
    const textEnd = open < 0 ? source.length : open;
    const text = source.slice(at, textEnd);
    if (text.trim() !== "" || stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) {
        throw new Error("Text outside the root element");
      }
      top.text += unescapeXml(text);
    }
    if (open < 0) {
      break;
    }
    if (source.startsWith("</", open)) {
      const close = source.indexOf(">", open);
      const name = source.slice(open + 2, close);
      const top = stack.pop();
      if (top === undefined || top.name !== name) {
        throw new Error(`Closing </${name}> does not match <${top?.name ?? "nothing"}>`);
      }
      at = close + 1;
      continue;
    }
    const nameMatch = /^[A-Za-z][\w.:-]*/.exec(source.slice(open + 1));
    if (nameMatch === null) {
      throw new Error(`A bare < at ${open}`);
    }
    const node: XmlNode = { name: nameMatch[0], attrs: {}, children: [], text: "" };
    let cursor = open + 1 + nameMatch[0].length;
    for (;;) {
      const attr = /^\s+([\w.:-]+)="([^"<>\n\t]*)"/.exec(source.slice(cursor));
      if (attr === null) {
        break;
      }
      node.attrs[attr[1] as string] = unescapeXml(attr[2] as string);
      cursor += attr[0].length;
    }
    const tail = /^\s*(\/?)>/.exec(source.slice(cursor));
    if (tail === null) {
      throw new Error(`Malformed tag <${node.name}> at ${open}: ${JSON.stringify(source.slice(cursor, cursor + 40))}`);
    }
    const parent = stack[stack.length - 1];
    if (parent !== undefined) {
      parent.children.push(node);
    } else if (root !== undefined) {
      throw new Error("A second root element");
    } else {
      root = node;
    }
    if (tail[1] !== "/") {
      stack.push(node);
    }
    at = cursor + tail[0].length;
  }
  if (stack.length > 0 || root === undefined) {
    throw new Error(`Unclosed <${stack[stack.length - 1]?.name ?? "root"}>`);
  }
  return root;
}

function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

function testCases(root: XmlNode): XmlNode[] {
  return childrenNamed(root, "testsuite").flatMap((suite) => childrenNamed(suite, "testcase"));
}

function caseNamed(root: XmlNode, name: string): XmlNode {
  const found = testCases(root).find((node) => node.attrs["name"] === name);
  if (found === undefined) {
    throw new Error(`No testcase named ${name}`);
  }
  return found;
}

// ---------------------------------------------------------------------------------------------

describe("the JSON report and its schema", () => {
  it("renders two-space indented JSON with a trailing newline that parses back to the report", () => {
    const report = sampleReport();
    const text = renderJson(report);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.startsWith('{\n  "tool": {')).toBe(true);
    expect(JSON.parse(text)).toEqual(report);
    expect(renderJson(report)).toBe(text);
  });

  it("matches the schema, with the program present or absent and with no forms", () => {
    expect(schemaErrors(JSON.parse(renderJson(sampleReport())))).toEqual([]);
    const inProcess = { ...sampleReport(), program: null };
    expect(schemaErrors(JSON.parse(renderJson(inProcess)))).toEqual([]);
    const empty = { ...sampleReport(), forms: [], summary: { scenarios: 0, passed: 0, failed: 0, skipped: 0, error: 0, parity: 0, problems: 0 }, verdict: "inconclusive" as const };
    expect(schemaErrors(JSON.parse(renderJson(empty)))).toEqual([]);
  });

  it("rejects a report with a field it does not know, a missing field or a value out of range", () => {
    const extra = JSON.parse(renderJson(sampleReport())) as Record<string, unknown>;
    extra["surprise"] = 1;
    expect(schemaErrors(extra)).toContain("$: unexpected surprise");

    const missing = JSON.parse(renderJson(sampleReport())) as Record<string, unknown>;
    delete missing["verdict"];
    expect(schemaErrors(missing)).toContain("$: missing verdict");

    const nested = JSON.parse(renderJson(sampleReport())) as { forms: Array<{ scenarios: Array<Record<string, unknown>> }> };
    (nested.forms[0] as { scenarios: Array<Record<string, unknown>> }).scenarios[0]!["status"] = "great";
    expect(schemaErrors(nested).some((error) => error.includes(".status"))).toBe(true);

    const badHash = JSON.parse(renderJson(sampleReport())) as { program: { sha256: string } };
    badHash.program.sha256 = "abc";
    expect(schemaErrors(badHash).some((error) => error.includes("$.program"))).toBe(true);
  });

  it("leaves the engine's own step and result objects open", () => {
    const report = sampleReport();
    const extra = JSON.parse(renderJson(report)) as { forms: Array<{ scenarios: Array<{ sides: { runtime: { steps: Array<Record<string, unknown>> } & Record<string, unknown> } }> }> };
    const side = extra.forms[0]!.scenarios[1]!.sides.runtime;
    side["futureDetail"] = true;
    side.steps[1]!["futureDetail"] = { nested: true };
    expect(schemaErrors(extra)).toEqual([]);
  });

  it("is a draft 2020-12 schema whose references all resolve", () => {
    expect(REPORT_SCHEMA.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    const refs = [...JSON.stringify(REPORT_SCHEMA).matchAll(/"\$ref":"#\/\$defs\/([A-Za-z]+)"/g)].map((match) => match[1] as string);
    expect(refs.length).toBeGreaterThan(10);
    for (const ref of refs) {
      expect(Object.keys(REPORT_SCHEMA.$defs)).toContain(ref);
    }
  });
});

describe("the JUnit report", () => {
  const report = sampleReport();
  const text = renderJunit(report);
  const root = parseXml(text);

  it("is well formed, with the declaration first and a stable rendering", () => {
    expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites ')).toBe(true);
    expect(text.endsWith("</testsuites>\n")).toBe(true);
    expect(renderJunit(sampleReport())).toBe(text);
    expect(root.name).toBe("testsuites");
    expect(root.attrs["name"]).toBe("datum-form-test");
  });

  it("counts what the summary counts: scenarios plus unparsed sources, failures with parity, errors with unparsed sources", () => {
    const summary = report.summary;
    expect(root.attrs["tests"]).toBe(String(summary.scenarios + summary.problems));
    expect(root.attrs["failures"]).toBe(String(summary.failed + summary.parity));
    expect(root.attrs["errors"]).toBe(String(summary.error + summary.problems));
    expect(root.attrs["skipped"]).toBe(String(summary.skipped));
    expect(root.attrs["time"]).toBe("1.234");
    const suites = childrenNamed(root, "testsuite");
    expect(suites.map((suite) => suite.attrs["name"])).toEqual(["forms/main.json", "forms/second.json"]);
    for (const suite of suites) {
      expect(suite.attrs["timestamp"]).toBe(SAMPLE_STARTED_AT);
      expect(childrenNamed(suite, "testcase").length).toBe(Number(suite.attrs["tests"]));
      expect(childrenNamed(suite, "testcase").flatMap((node) => childrenNamed(node, "failure")).length).toBe(Number(suite.attrs["failures"]));
      expect(childrenNamed(suite, "testcase").flatMap((node) => childrenNamed(node, "error")).length).toBe(Number(suite.attrs["errors"]));
      expect(childrenNamed(suite, "testcase").flatMap((node) => childrenNamed(node, "skipped")).length).toBe(Number(suite.attrs["skipped"]));
    }
    const main = suites[0] as XmlNode;
    expect(main.attrs["tests"]).toBe("6");
    expect(main.attrs["time"]).toBe("0.052");
    expect(suites[1]?.attrs["time"]).toBe("0.003");
  });

  it("writes a passed scenario as an empty testcase with its classname and seconds", () => {
    const passed = caseNamed(root, "adult sees the licence field");
    expect(passed.attrs["classname"]).toBe("forms.main");
    expect(passed.children).toEqual([]);
    expect(caseNamed(root, "total must be positive").attrs["time"]).toBe("0.008");
    expect(caseNamed(root, "needs a host role").attrs["time"]).toBe("0.000");
  });

  it("writes a failed scenario as a failure with the first failing step as its message and every failing step in the body", () => {
    const failed = caseNamed(root, "total must be positive");
    const failure = childrenNamed(failed, "failure")[0] as XmlNode;
    expect(failure.attrs["message"]).toBe('Expected "total" to be 1, but it is 0.');
    // Both sides failed alike, so each line is listed once and carries no side tag.
    expect(failure.text.split("\n")).toEqual([
      '4: Expected "total" to be 1, but it is 0.',
      `7: Expected the message ${JSON.stringify(AWKWARD_MESSAGE)} on "email", but its messages are [].`
    ]);
  });

  it("writes a parity scenario as a failure of type parity listing the differing lines", () => {
    const parity = caseNamed(root, AWKWARD_NAME);
    const failure = childrenNamed(parity, "failure")[0] as XmlNode;
    expect(failure.attrs["type"]).toBe("parity");
    expect(failure.attrs["message"]).toBe("The runtime and the kernel differ on lines 4, 7.");
    expect(failure.text.split("\n")).toEqual([
      "4: runtime passed; kernel failed expect.visible (got false)",
      "7: runtime passed; kernel failed expect.required (got false)"
    ]);
    expect(text).toContain('type="parity"');
  });

  it("words a scenario-level parity difference when no line differs", () => {
    const changed = sampleReport();
    const scenario = changed.forms[0]!.scenarios[4]!;
    scenario.parity = { status: "differ", lines: [], scenario: { runtime: { status: "passed" }, kernel: { status: "error", reason: "scenario.driverFailed" } } };
    const node = caseNamed(parseXml(renderJunit(changed)), AWKWARD_NAME);
    const failure = childrenNamed(node, "failure")[0] as XmlNode;
    expect(failure.attrs["type"]).toBe("parity");
    expect(failure.attrs["message"]).toBe("The runtime came to passed and the kernel to error (scenario.driverFailed).");
  });

  it("writes an error scenario as an error and a skipped one as skipped, each with its reason worded", () => {
    const error = childrenNamed(caseNamed(root, "clock rule without today"), "error")[0] as XmlNode;
    expect(error.attrs["type"]).toBe("scenario.clockUnset");
    expect(error.attrs["message"]).toBe("The form reads the current date, so the scenario must say which day it is: add a given today.");
    const skipped = childrenNamed(caseNamed(root, "needs a host role"), "skipped")[0] as XmlNode;
    expect(skipped.attrs["message"]).toBe("Skipped: waiting on a host role");
  });

  // A consumer splits the classname at the last dot into package and class.
  it("builds the classname from the path without its extension, separators as dots", () => {
    expect(classNameOf("forms/main.json")).toBe("forms.main");
    expect(classNameOf("./forms/main.json")).toBe("forms.main");
    expect(classNameOf("/abs/forms/main.json")).toBe("abs.forms.main");
    expect(classNameOf("forms\\main.json")).toBe("forms.main");
    expect(classNameOf("main")).toBe("main");
    expect(classNameOf(".hidden")).toBe(".hidden");
  });

  // --fail-on untested fails the run for a reason no scenario's case carries.
  it("adds a failing 'every rule is tested' case per form with untested rules under failOn untested, and only then", () => {
    expect(testCases(root).some((node) => node.attrs["name"] === "every rule is tested")).toBe(false);
    const strict = sampleReport();
    strict.failOn = "untested";
    const strictRoot = parseXml(renderJunit(strict));
    const node = caseNamed(strictRoot, "every rule is tested");
    expect(node.attrs["classname"]).toBe("forms.main");
    const failure = childrenNamed(node, "failure")[0] as XmlNode;
    expect(failure).toMatchObject({ attrs: { type: "coverage", message: "2 rules are not tested" } });
    expect(failure.text.split("\n")).toEqual(["Total must be above zero", "Tax is 13% of the total"]);
    expect(strictRoot.attrs["tests"]).toBe(String(Number(root.attrs["tests"]) + 1));
    expect(strictRoot.attrs["failures"]).toBe(String(Number(root.attrs["failures"]) + 1));
    for (const suite of childrenNamed(strictRoot, "testsuite")) {
      expect(childrenNamed(suite, "testcase").length).toBe(Number(suite.attrs["tests"]));
      expect(childrenNamed(suite, "testcase").flatMap((entry) => childrenNamed(entry, "failure")).length).toBe(Number(suite.attrs["failures"]));
    }
  });

  // Two scenarios of one name must not merge in a consumer keyed on the pair.
  it("numbers a repeated scenario name so a consumer does not merge the cases", () => {
    const repeated = sampleReport();
    const form = repeated.forms[0]!;
    const first = form.scenarios[0]!;
    form.scenarios.push({ ...first });
    const names = testCases(parseXml(renderJunit(repeated))).map((node) => node.attrs["name"]);
    expect(names.filter((name) => name === first.name)).toHaveLength(1);
    expect(names).toContain(`${first.name} (2)`);
  });

  it("writes a source that does not parse as one testcase in an error listing its problems", () => {
    const node = caseNamed(root, "forms/broken.datum-test parses");
    expect(node.attrs["classname"]).toBe("forms.main");
    const error = childrenNamed(node, "error")[0] as XmlNode;
    expect(error.attrs["message"]).toBe("2 problems in forms/broken.datum-test");
    expect(error.attrs["type"]).toBe("parse");
    expect(error.text.split("\n")).toEqual(['3: Unknown statement "expekt".', "8: " + kernelFormTestMessage("expectedPath", { token: "!" })]);
  });

  it("escapes names and messages: the parsed text equals the original, and the raw text has no bare special character", () => {
    expect(caseNamed(root, AWKWARD_NAME).attrs["name"]).toBe(AWKWARD_NAME);
    expect(text).toContain('name="a &lt; b &amp; &quot;quoted&quot; &apos;single&apos; | c"');
    const failure = childrenNamed(caseNamed(root, "total must be positive"), "failure")[0] as XmlNode;
    expect(failure.text).toContain(AWKWARD_MESSAGE.replace(/"/g, '\\"'));
    expect(text).toContain("&lt;your&gt; name &amp;");
  });

  it("keeps characters XML cannot carry out of the document and keeps newlines in attributes as references", () => {
    expect(escapeXmlAttribute("a\nb\tc\u0001d￾e")).toBe("a&#10;b&#9;c�d�e");
    expect(escapeXmlText("a\r\nb \uD800 c")).toBe("a&#13;\nb � c");
    expect(escapeXmlText("]]> & <")).toBe("]]&gt; &amp; &lt;");
    const changed = sampleReport();
    changed.forms[1]!.scenarios[0]!.name = "two\nlines \u0001 here";
    const parsed = parseXml(renderJunit(changed));
    expect(testCases(parsed).some((node) => node.attrs["name"] === "two\nlines � here")).toBe(true);
  });

  it("tags a finding that only one side made, and reads an empty report as an empty suite list", () => {
    const changed = sampleReport();
    const scenario = changed.forms[0]!.scenarios[1]!;
    scenario.sides.kernel = { ...scenario.sides.kernel!, status: "passed", steps: [{ line: 4, status: "passed" }] };
    const failure = childrenNamed(caseNamed(parseXml(renderJunit(changed)), "total must be positive"), "failure")[0] as XmlNode;
    expect(failure.text.split("\n").every((line) => line.includes("[runtime] "))).toBe(true);

    const none = parseXml(renderJunit({ ...sampleReport(), forms: [], summary: { scenarios: 0, passed: 0, failed: 0, skipped: 0, error: 0, parity: 0, problems: 0 } }));
    expect(none.attrs["tests"]).toBe("0");
    expect(none.children).toEqual([]);
  });
});

describe("the Markdown report", () => {
  const report = sampleReport();
  const text = renderMarkdown(report);
  const lines = text.split("\n");

  it("has the title, the run line and the totals", () => {
    expect(lines[0]).toBe("# Datum form tests: failed");
    expect(text).toContain("Runner both | Program dist/datum-wasm.js (123456 B, sha256 01234567) | Started 2026-10-24T12:00:00.000Z | 1.2 s | Fail on failed");
    expect(text).toContain("6 scenarios: 2 passed, 1 failed, 1 parity, 1 error, 1 skipped. 1 source with problems.");
    expect(renderMarkdown(sampleReport())).toBe(text);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(renderMarkdown({ ...sampleReport(), program: null })).toContain("Program in-process kernel");
  });

  it("has a heading and a scenario table per form, one row per scenario", () => {
    expect(lines).toContain("## forms/main.json");
    expect(lines).toContain("_Main form_");
    expect(lines).toContain("## forms/second.json");
    expect(lines).toContain("| Scenario | Runtime | Kernel | Result |");
    expect(lines).toContain("| adult sees the licence field | passed | passed | PASS |");
    expect(lines).toContain("| total must be positive | failed | failed | FAIL |");
    expect(lines).toContain("| needs a host role | skipped (waiting on a host role) | skipped (waiting on a host role) | SKIP |");
    expect(lines).toContain("| clock rule without today | error (scenario.clockUnset) | error (scenario.clockUnset) | ERROR |");
    expect(lines).toContain("| second form works | passed | passed | PASS |");
    const parityRow = lines.find((line) => line.endsWith("| PARITY |")) as string;
    expect(parityRow).toBe("| a \\< b & \"quoted\" 'single' \\| c | passed | failed | PARITY |");
  });

  it("keeps every table row the width of its header, whatever the names hold", () => {
    const width = (line: string): number => (line.match(/(?<!\\)\|/g) ?? []).length;
    const rows = lines.filter((line) => line.startsWith("| "));
    expect(rows.length).toBeGreaterThan(10);
    const header = lines.indexOf("| Scenario | Runtime | Kernel | Result |");
    for (const line of lines.slice(header, header + 8).filter((entry) => entry.startsWith("|"))) {
      expect(width(line)).toBe(5);
    }
  });

  it("details each scenario that did not pass, with the line, the message and expected and actual as JSON", () => {
    expect(lines).toContain("### Details");
    expect(lines).toContain("#### total must be positive");
    expect(lines).toContain("| Side | Line | Message | Expected | Actual |");
    expect(text).toContain('| both | 4 | Expected "total" to be 1, but it is 0. | 1 | 0 |');
    // The message holds characters Markdown would read; they arrive escaped.
    expect(text).toContain("Enter \\<your\\> name & ");
    expect(lines).toContain("| Line | Runtime | Kernel |");
    expect(lines).toContain("| 4 | passed | failed expect.visible (got false) |");
    expect(lines).toContain("- both: Skipped: waiting on a host role");
    expect(text).not.toContain("#### adult sees the licence field");
    expect(text).not.toContain("#### second form works");
  });

  it("lists parse problems under their source", () => {
    expect(lines).toContain("### Problems in forms/broken.datum-test");
    expect(lines).toContain('| 3 | Unknown statement "expekt". |');
  });

  it("puts the untested rules first and bold in the coverage table", () => {
    expect(lines).toContain("### Coverage");
    expect(text).toContain("2 of 4 rules tested, 2 untested.");
    const header = lines.indexOf("| Rule | Target | Formula | Scenarios |");
    expect(header).toBeGreaterThan(0);
    const rows = lines.slice(header + 2, header + 6);
    expect(rows[0]).toBe("| **Total must be above zero** | total | total \\> 0 | **untested** |");
    expect(rows[1]).toBe("| **Tax is 13% of the total** | tax | total \\* 0.13 | **untested** |");
    expect(rows[2]).toContain("| Show licence when age \\>= 16 |");
    expect(rows[2]).toContain("| adult sees the licence field |");
    expect(rows[2]?.includes("**")).toBe(false);
    expect(rows[3]?.includes("**")).toBe(false);
    expect(rows[3]).toContain("total must be positive, a \\< b & \"quoted\" 'single' \\| c");
  });

  it("says when a form has no scenarios and leaves out coverage that was not asked for", () => {
    const empty = sampleReport();
    empty.forms[1]!.scenarios = [];
    expect(renderMarkdown(empty)).toContain("No scenarios.");
    const one = sampleReport();
    delete one.forms[0]!.coverage;
    expect(renderMarkdown(one)).not.toContain("### Coverage");
  });

  // The parser accepts \n, \r and \t in a name; none may start a row or a heading.
  it("keeps a line break in a scenario name from starting a row, a heading or a log line", () => {
    const awkward = sampleReport();
    const target = awkward.forms[0]!.scenarios.find((scenario) => scenario.status === "failed")!;
    target.name = "fails\n## Injected heading\n| a | b |\rcarriage";
    const rendered = renderMarkdown(awkward).split("\n");
    expect(rendered).not.toContain("## Injected heading");
    expect(rendered.some((line) => line.startsWith("## Injected"))).toBe(false);
    expect(renderMarkdown(awkward)).not.toContain("\r");
    expect(rendered).toContain("#### fails ## Injected heading \\| a \\| b \\| carriage");
    expect(escapeMarkdown("a\rb\r\nc\nd")).toBe("a b c d");
  });

  it("escapes what Markdown would read", () => {
    expect(escapeMarkdown("a|b*c_d`e<f>g[h]\\")).toBe("a\\|b\\*c\\_d\\`e\\<f\\>g\\[h\\]\\\\");
  });
});

describe("the words", () => {
  const engine = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(`../../../engine/form-engine/${relative}`, import.meta.url)), "utf8");

  const files = [
    "core/form-tests/form-test-run.ts",
    "core/form-tests/form-test-types.ts",
    "runtime/browser/form-test-runtime-driver.ts",
    "validation/wasm/form-test-kernel-driver.ts"
  ];

  it("has a row for every code the engine's sources emit", () => {
    const found = new Set<string>();
    for (const file of files) {
      for (const match of engine(file).matchAll(/"((?:expect|action|scenario|unreplayable|snapshot)\.[A-Za-z]+)"/g)) {
        found.add(match[1] as string);
      }
    }
    // The judge builds the state codes by concatenation, so they are read from the state union.
    const states = /export type FormTestState =([^;]*);/.exec(engine("core/form-tests/form-test-types.ts"));
    expect(states).not.toBeNull();
    for (const state of (states![1] as string).matchAll(/"([A-Za-z]+)"/g)) {
      found.add(`expect.${state[1]}`);
    }
    expect([...found]).toEqual(expect.arrayContaining(["expect.unknownField", "expect.visible", "expect.notEmpty", "action.refused", "scenario.driverFailed", "scenario.tooManySteps", "unreplayable.clientDerived", "snapshot.failed"]));
    const missing = [...found].filter((code) => !hasWord(code));
    expect(missing).toEqual([]);
  });

  it("words every code in the table as a sentence, even with no params, without leaking undefined", () => {
    for (const code of wordedCodes()) {
      for (const message of [stepMessage({ line: 1, status: "failed", code }), stepMessage({ line: 1, status: "failed", code, expected: 1, actual: 2, params: { path: "x", page: "p", op: "ne" } })]) {
        expect(message, code).toMatch(/\S/);
        expect(message, code).not.toMatch(/undefined|\[object|NaN/);
        expect(message, code).toMatch(/[.!]$/);
      }
    }
  });

  it("falls back to the code and the params as JSON for a code it does not know", () => {
    expect(stepMessage({ line: 2, status: "failed", code: "expect.future", params: { a: 1, b: "two" } })).toBe('expect.future {"a":1,"b":"two"}');
    expect(stepMessage({ line: 2, status: "failed", code: "expect.future" })).toBe("expect.future");
    expect(stepMessage({ line: 2, status: "failed", code: "expect.future", params: {} })).toBe("expect.future");
    expect(scenarioReasonMessage({ name: "n", status: "error", reason: "scenario.future", params: { x: true }, steps: [] })).toBe('scenario.future {"x":true}');
  });

  it("says only the status for a step with no code", () => {
    expect(stepMessage({ line: 1, status: "ran" })).toBe("Ran.");
    expect(stepMessage({ line: 1, status: "passed" })).toBe("Passed.");
    expect(stepMessage({ line: 1, status: "skipped" })).toBe("Skipped.");
    expect(stepMessage({ line: 1, status: "failed" })).toBe("Failed.");
    expect(stepMessage({ line: 1, status: "error" })).toBe("Errored.");
  });

  it("words the expectations with their expected and actual values as compact JSON", () => {
    expect(stepMessage({ line: 1, status: "failed", code: "expect.visible", expected: true, actual: false, params: { path: "licence" } })).toBe('Expected "licence" to be visible, but it is hidden.');
    expect(stepMessage({ line: 1, status: "failed", code: "expect.value", expected: "ON", actual: null, params: { path: "province", op: "eq" } })).toBe('Expected "province" to be "ON", but it is null.');
    expect(stepMessage({ line: 1, status: "failed", code: "expect.value", expected: 2, actual: 2, params: { path: "n", op: "ne" } })).toBe('Expected "n" not to be 2, but it is.');
    expect(stepMessage({ line: 1, status: "failed", code: "expect.path", expected: ["a", "b"], actual: ["a", "c", "d"] })).toBe("Expected the path a > b, but it is a > c > d.");
    expect(stepMessage({ line: 1, status: "failed", code: "expect.pathEnd", expected: { end: "exit", last: "stop" }, actual: { end: "end" } })).toBe('Expected the path to end where it stops at the exit page "stop", but it runs off the end.');
    expect(stepMessage({ line: 1, status: "failed", code: "expect.rows", expected: 1, actual: 3, params: { path: "items" } })).toBe('Expected "items" to have 1 row, but it has 3 rows.');
    expect(stepMessage({ line: 1, status: "failed", code: "expect.error", expected: "required", actual: ["rule"], params: { path: "name" } })).toBe('Expected the error "required" on "name", but its errors are ["rule"].');
    expect(stepMessage({ line: 1, status: "failed", code: "expect.error", expected: null, actual: [], params: { path: "name" } })).toBe('Expected an error on "name", but it has no error.');
    expect(stepMessage({ line: 1, status: "failed", code: "expect.noError", expected: [], actual: [{ path: "name", code: "required" }] })).toBe('Expected no errors, but found [{"path":"name","code":"required"}].');
    expect(stepMessage({ line: 1, status: "failed", code: "expect.verdict", expected: "accepted", actual: "refused" })).toBe("Expected the form to be accepted, but it was refused.");
    expect(stepMessage({ line: 1, status: "failed", code: "expect.layout", expected: "letter", actual: null })).toBe('Expected the PDF layout "letter", but the answers choose none.');
    expect(stepMessage({ line: 1, status: "failed", code: "expect.formula", expected: true, actual: false, params: { formula: "a > b" } })).toBe('The formula "a > b" is not true; it came to false.');
    expect(stepMessage({ line: 1, status: "failed", code: "expect.formula", expected: true, params: { formula: "a > b", evaluated: false } })).toBe('The formula "a > b" could not be evaluated.');
    expect(stepMessage({ line: 1, status: "failed", code: "expect.unknownField", params: { path: "items[3].qty", reason: "rowOutOfRange" } })).toBe('"items[3].qty" names a row the form does not have.');
    expect(stepMessage({ line: 1, status: "failed", code: "expect.unknownField", params: { path: "nope" } })).toBe('The form has no field "nope".');
    expect(stepMessage({ line: 1, status: "failed", code: "expect.onPath", expected: false, actual: true, params: { page: "p2" } })).toBe('Expected page "p2" to be off the path, but it is on it.');
  });

  it("words skipped steps, refused actions and the other codes the runner emits", () => {
    expect(stepMessage({ line: 4, status: "skipped", code: "unreplayable.host" })).toBe("Skipped: a rule reads the host context and the scenario gives no host value.");
    expect(stepMessage({ line: 4, status: "error", code: "action.refused", params: { action: "addRow", reason: "rows.max", path: "items" } })).toBe(
      'The form refused the addRow action on "items": the collection already holds the most rows it may (maxRows).'
    );
    expect(stepMessage({ line: 4, status: "error", code: "action.refused", params: { action: "change", reason: "change.off", path: "name" } })).toBe(
      'The form refused the change action on "name": the Check answers step has its Change links off.'
    );
    expect(stepMessage({ line: 4, status: "error", code: "action.failed", params: { message: "boom" } })).toBe("An action failed: boom.");
    expect(stepMessage({ line: 4, status: "error", code: "snapshot.failed", params: { message: "boom" } })).toBe("The form's state could not be read after the last action: boom.");
  });

  it("words the scenario-level reasons, with their params", () => {
    const result = (reason: string, params?: Record<string, unknown>, status: "error" | "skipped" = "error") =>
      scenarioReasonMessage({ name: "n", status, reason, ...(params === undefined ? {} : { params }), steps: [] });
    expect(result("scenario.clockUnset")).toBe("The form reads the current date, so the scenario must say which day it is: add a given today.");
    expect(result("scenario.unknownJourney", { journey: "main" })).toBe('The form has no journey "main" (given journey).');
    expect(result("scenario.badGiven", { given: "locale", locale: "fr" })).toBe('The form does not offer the locale "fr" (given locale).');
    expect(result("scenario.badGiven", { given: "options", path: "province", reason: "noSource" })).toBe('The choices of "province" do not come from a data source, so given options cannot set them.');
    expect(result("scenario.badGiven", { given: "options", path: "nope", reason: "unknownField" })).toBe('Given options names "nope", which the form does not have.');
    expect(result("scenario.formulaInvalid", { problems: [{ code: "unknownFunction", where: "total.rules.value" }] })).toBe(
      "The form's formulas do not compile (unknownFunction at total.rules.value), so there is no form to test."
    );
    expect(result("scenario.driverFailed")).toBe("This side could not be set up for the form.");
    expect(result("scenario.tooManySteps")).toBe("The scenario has more than 1000 statements.");
    expect(result("unreplayable.clock", undefined, "skipped")).toContain("today's date");
    expect(result("not decided yet", undefined, "skipped")).toBe("Skipped: not decided yet");
    expect(scenarioReasonMessage({ name: "n", status: "skipped", steps: [] })).toBe("Skipped.");
    expect(scenarioReasonMessage({ name: "n", status: "error", steps: [] })).toBe("The scenario ended in an error.");
    expect(scenarioReasonMessage({ name: "n", status: "passed", steps: [] })).toBe("");
  });

  it("words a parse problem with the engine's own sentence", () => {
    const problem = { code: "unknownStatement" as const, line: 3, start: 0, end: 6, params: { word: "expekt" } };
    expect(problemMessage(problem)).toBe(kernelFormTestMessage("unknownStatement", { word: "expekt" }));
    expect(problemMessage({ code: "tooLong", line: 1, start: 0, end: 1 })).toBe("The tests are longer than 200000 characters.");
  });

  it("names the statuses and cuts long JSON", () => {
    expect(["passed", "failed", "skipped", "error", "parity"].map((status) => statusWord(status as never))).toEqual(["PASS", "FAIL", "SKIP", "ERROR", "PARITY"]);
    const long = compactJson("x".repeat(500));
    expect(long.length).toBe(160);
    expect(long.endsWith("…")).toBe(true);
    expect(compactJson({ a: [1, 2] })).toBe('{"a":[1,2]}');
    expect(compactJson(undefined)).toBe("nothing");
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(compactJson(circular)).toBe("[object Object]");
  });
});
