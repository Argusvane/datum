/**
 * The JUnit XML report: one `testsuite` per form, one `testcase` per
 * scenario, so a CI system that reads JUnit shows a form's scenarios as its tests. Deterministic:
 * the only time in it is the report's own `startedAt` and the durations the run measured.
 *
 * Mapping: `failed` is a `failure` listing every failing step; `parity` is a `failure` of type
 * `parity` listing the lines the two sides came to differently (the finding class the two-sided
 * design exists for); `error` is an `error`; `skipped` is a `skipped`; a source that does not
 * parse is one extra test case, `<source> parses`, in an `error`.
 */
import { findingsOf, problemMessage, sidePrefix, sourceLabel, stepCellWord } from "./words.js";
import type { Finding } from "./words.js";
import type { FormReport, ParityLine, Report, ScenarioReport } from "./model.js";

// Characters XML 1.0 cannot carry at all: replaced, never emitted raw.
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function clean(text: string): string {
  return text.replace(INVALID_XML, "�");
}

/** Text content: `&`, `<`, `>`; a carriage return as a reference so a reader keeps it. */
export function escapeXmlText(text: string): string {
  return clean(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#13;");
}

/** Attribute values: the text escapes, the quotes, and the whitespace an attribute would normalise away. */
export function escapeXmlAttribute(text: string): string {
  return escapeXmlText(text).replace(/"/g, "&quot;").replace(/'/g, "&apos;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
}

/** Seconds with three decimals, as JUnit consumers expect. */
function seconds(milliseconds: number): string {
  return (Math.max(0, milliseconds) / 1000).toFixed(3);
}

function attributes(pairs: Array<[string, string | number]>): string {
  return pairs.map(([name, value]) => ` ${name}="${escapeXmlAttribute(String(value))}"`).join("");
}

export function parityLineWord(line: ParityLine): string {
  return `${line.line}: runtime ${stepCellWord(line.runtime)}; kernel ${stepCellWord(line.kernel)}`;
}

function findingLine(scenario: ScenarioReport, finding: Finding): string {
  const where = finding.line === undefined ? "" : `${finding.line}: `;
  return `${sidePrefix(scenario, finding)}${where}${finding.message}`;
}

interface Counts {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  seconds: number;
}

function emptyCounts(): Counts {
  return { tests: 0, failures: 0, errors: 0, skipped: 0, seconds: 0 };
}

function countsAttributes(counts: Counts): Array<[string, string | number]> {
  return [
    ["tests", counts.tests],
    ["failures", counts.failures],
    ["errors", counts.errors],
    ["skipped", counts.skipped],
    ["time", seconds(counts.seconds)]
  ];
}

function bodyOf(lines: string[]): string {
  return escapeXmlText(lines.join("\n"));
}

/**
 * The `classname` of a form's test cases. Consumers such as Jenkins split it at the last dot into
 * package and class, so the path's own extension would show every form as class `json`; the path
 * without its extension, separators as dots, reads as a package and a class.
 * The testsuite keeps the full path as its name.
 */
export function classNameOf(path: string): string {
  const segments = path.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
  const last = segments.length - 1;
  if (last >= 0) {
    const dot = (segments[last] as string).lastIndexOf(".");
    if (dot > 0) {
      segments[last] = (segments[last] as string).slice(0, dot);
    }
  }
  return segments.join(".");
}

/** One scenario's `testcase`, and what it adds to the suite's counts. `name` is the test's name in the suite (see `uniqueNames`). */
function testCase(form: FormReport, scenario: ScenarioReport, name: string, counts: Counts): string {
  const head = `    <testcase${attributes([["classname", classNameOf(form.path)], ["name", name], ["time", seconds(scenario.durationMs)]])}`;
  counts.tests += 1;
  counts.seconds += scenario.durationMs;
  switch (scenario.status) {
    case "passed":
      return `${head}/>`;
    case "failed": {
      counts.failures += 1;
      const findings = findingsOf(scenario, "failed");
      const first = findings[0];
      const message = first === undefined ? "The scenario failed." : first.message;
      return `${head}>\n      <failure${attributes([["message", message], ["type", "failed"]])}>${bodyOf(findings.map((finding) => findingLine(scenario, finding)))}</failure>\n    </testcase>`;
    }
    case "parity": {
      counts.failures += 1;
      const lines = scenario.parity?.lines ?? [];
      const body = lines.map(parityLineWord);
      let message: string;
      if (lines.length > 0) {
        message = `The runtime and the kernel differ on line${lines.length === 1 ? "" : "s"} ${lines.map((line) => line.line).join(", ")}.`;
      } else if (scenario.parity?.scenario !== undefined) {
        const sides = scenario.parity.scenario;
        const word = (side: { status: string; reason?: string }): string => (side.reason === undefined ? side.status : `${side.status} (${side.reason})`);
        message = `The runtime came to ${word(sides.runtime)} and the kernel to ${word(sides.kernel)}.`;
        body.push(`runtime: ${word(sides.runtime)}`, `kernel: ${word(sides.kernel)}`);
      } else {
        message = "The runtime and the kernel differ.";
      }
      return `${head}>\n      <failure${attributes([["message", message], ["type", "parity"]])}>${bodyOf(body)}</failure>\n    </testcase>`;
    }
    case "error": {
      counts.errors += 1;
      const findings = findingsOf(scenario, "error");
      const first = findings[0];
      const message = first === undefined ? "The scenario ended in an error." : first.message;
      const type = first?.code ?? "error";
      return `${head}>\n      <error${attributes([["message", message], ["type", type]])}>${bodyOf(findings.map((finding) => findingLine(scenario, finding)))}</error>\n    </testcase>`;
    }
    default: {
      counts.skipped += 1;
      const findings = findingsOf(scenario, "skipped");
      const first = findings[0];
      const message = first === undefined ? "Skipped." : first.message;
      return `${head}>\n      <skipped${attributes([["message", message]])}/>\n    </testcase>`;
    }
  }
}

/** A source that does not parse is one test case in an error, so a broken file cannot pass by having no scenarios. */
function problemCases(form: FormReport, counts: Counts): string[] {
  const cases: string[] = [];
  for (const source of form.sources) {
    if (source.problems.length === 0) {
      continue;
    }
    counts.tests += 1;
    counts.errors += 1;
    const label = sourceLabel(source.source);
    const lines = source.problems.map((problem) => `${problem.line}: ${problemMessage(problem)}`);
    const message = `${source.problems.length} problem${source.problems.length === 1 ? "" : "s"} in ${label}`;
    cases.push(
      `    <testcase${attributes([["classname", classNameOf(form.path)], ["name", `${label} parses`], ["time", "0.000"]])}>\n      <error${attributes([["message", message], ["type", "parse"]])}>${bodyOf(lines)}</error>\n    </testcase>`
    );
  }
  return cases;
}

/**
 * The names the form's test cases carry. A name used by two sources is a `duplicateName` problem,
 * yet both scenarios run; a consumer that keys on classname and name would merge them and show
 * one, so the later ones are numbered.
 */
function uniqueNames(scenarios: readonly ScenarioReport[]): string[] {
  const seen = new Map<string, number>();
  return scenarios.map((scenario) => {
    const count = (seen.get(scenario.name) ?? 0) + 1;
    seen.set(scenario.name, count);
    return count === 1 ? scenario.name : `${scenario.name} (${count})`;
  });
}

/**
 * Under `--fail-on untested` the run fails for a rule no scenario reached, which no scenario's
 * test case says: without this case a test-report widget shows every case green on a red job.
 * The vitest helper registers the same test, "every rule is tested".
 */
function coverageCase(form: FormReport, counts: Counts): string[] {
  const untested = (form.coverage?.rules ?? []).filter((rule) => rule.scenarios.length === 0);
  if (untested.length === 0) {
    return [];
  }
  counts.tests += 1;
  counts.failures += 1;
  const message = `${untested.length} rule${untested.length === 1 ? " is" : "s are"} not tested`;
  const lines = untested.map((rule) => (rule.sentence === "" ? `${rule.kind} ${rule.ruleKey}` : rule.sentence));
  return [
    `    <testcase${attributes([["classname", classNameOf(form.path)], ["name", "every rule is tested"], ["time", "0.000"]])}>\n      <failure${attributes([["message", message], ["type", "coverage"]])}>${bodyOf(lines)}</failure>\n    </testcase>`
  ];
}

export function renderJunit(report: Report): string {
  const total = emptyCounts();
  const suites: string[] = [];
  for (const form of report.forms) {
    const counts = emptyCounts();
    const names = uniqueNames(form.scenarios);
    const cases = [
      ...form.scenarios.map((scenario, index) => testCase(form, scenario, names[index] as string, counts)),
      ...problemCases(form, counts),
      ...(report.failOn === "untested" ? coverageCase(form, counts) : [])
    ];
    total.tests += counts.tests;
    total.failures += counts.failures;
    total.errors += counts.errors;
    total.skipped += counts.skipped;
    total.seconds += counts.seconds;
    const open = `  <testsuite${attributes([["name", form.path], ...countsAttributes(counts), ["timestamp", report.startedAt]])}>`;
    suites.push(cases.length === 0 ? `${open}\n  </testsuite>` : `${open}\n${cases.join("\n")}\n  </testsuite>`);
  }
  // The run's own duration, not the sum of the cases: set-up and parsing take time too.
  const head = `<testsuites${attributes([["name", "datum-form-test"], ...countsAttributes({ ...total, seconds: report.durationMs })])}>`;
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', head, ...suites, "</testsuites>"];
  return `${lines.join("\n")}\n`;
}
