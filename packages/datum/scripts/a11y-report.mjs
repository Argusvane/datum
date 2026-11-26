// Renders the form's accessibility summary from its two committed baselines —
// a11y/baseline/markup.json (axe in jsdom, Datum's binding) and browser.json (axe in Chrome, colour
// on, the binding under each colour scheme) — to docs/generated/theme-accessibility.md at the
// repository root. Pure: the same baselines render the same document, which is what
// tests/a11y-report.test.ts holds the committed file to. No dates, no machine names.
//
//   npm run a11y:report
//   node scripts/a11y-report.mjs --stdout
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import axe from "axe-core";

import { AUDIT_STATES, FIXTURE_PARTS, WCAG_TAGS, criteriaFromTags } from "../a11y/audit-support.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The committed document. */
export const REPORT_PATH = join(root, "..", "..", "docs", "generated", "theme-accessibility.md");

/** The variants of the Datum form the audits cover: its binding under a colour scheme. */
const VARIANTS = [
  { id: "datum-light", label: "Datum (light)", scheme: "light" },
  { id: "datum-dark", label: "Datum (dark)", scheme: "dark" }
];

/** The two baselines under `<dir>/a11y/baseline/`, each undefined when absent. */
export function readBaselines(dir = root) {
  const read = (name) => {
    const path = join(dir, "a11y", "baseline", name);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
  };
  return { markup: read("markup.json"), browser: read("browser.json") };
}

/** WCAG 2.2 success criteria at A and AA, named as the standard names them. */
const CRITERIA = {
  "1.1.1": ["A", "Non-text Content"],
  "1.2.1": ["A", "Audio-only and Video-only (Prerecorded)"],
  "1.2.2": ["A", "Captions (Prerecorded)"],
  "1.2.3": ["A", "Audio Description or Media Alternative (Prerecorded)"],
  "1.2.4": ["AA", "Captions (Live)"],
  "1.2.5": ["AA", "Audio Description (Prerecorded)"],
  "1.3.1": ["A", "Info and Relationships"],
  "1.3.2": ["A", "Meaningful Sequence"],
  "1.3.3": ["A", "Sensory Characteristics"],
  "1.3.4": ["AA", "Orientation"],
  "1.3.5": ["AA", "Identify Input Purpose"],
  "1.4.1": ["A", "Use of Color"],
  "1.4.2": ["A", "Audio Control"],
  "1.4.3": ["AA", "Contrast (Minimum)"],
  "1.4.4": ["AA", "Resize Text"],
  "1.4.5": ["AA", "Images of Text"],
  "1.4.10": ["AA", "Reflow"],
  "1.4.11": ["AA", "Non-text Contrast"],
  "1.4.12": ["AA", "Text Spacing"],
  "1.4.13": ["AA", "Content on Hover or Focus"],
  "2.1.1": ["A", "Keyboard"],
  "2.1.2": ["A", "No Keyboard Trap"],
  "2.1.4": ["A", "Character Key Shortcuts"],
  "2.2.1": ["A", "Timing Adjustable"],
  "2.2.2": ["A", "Pause, Stop, Hide"],
  "2.3.1": ["A", "Three Flashes or Below Threshold"],
  "2.4.1": ["A", "Bypass Blocks"],
  "2.4.2": ["A", "Page Titled"],
  "2.4.3": ["A", "Focus Order"],
  "2.4.4": ["A", "Link Purpose (In Context)"],
  "2.4.5": ["AA", "Multiple Ways"],
  "2.4.6": ["AA", "Headings and Labels"],
  "2.4.7": ["AA", "Focus Visible"],
  "2.4.11": ["AA", "Focus Not Obscured (Minimum)"],
  "2.5.1": ["A", "Pointer Gestures"],
  "2.5.2": ["A", "Pointer Cancellation"],
  "2.5.3": ["A", "Label in Name"],
  "2.5.4": ["A", "Motion Actuation"],
  "2.5.7": ["AA", "Dragging Movements"],
  "2.5.8": ["AA", "Target Size (Minimum)"],
  "3.1.1": ["A", "Language of Page"],
  "3.1.2": ["AA", "Language of Parts"],
  "3.2.1": ["A", "On Focus"],
  "3.2.2": ["A", "On Input"],
  "3.2.3": ["AA", "Consistent Navigation"],
  "3.2.4": ["AA", "Consistent Identification"],
  "3.2.6": ["A", "Consistent Help"],
  "3.3.1": ["A", "Error Identification"],
  "3.3.2": ["A", "Labels or Instructions"],
  "3.3.3": ["AA", "Error Suggestion"],
  "3.3.4": ["AA", "Error Prevention (Legal, Financial, Data)"],
  "3.3.7": ["A", "Redundant Entry"],
  "3.3.8": ["AA", "Accessible Authentication (Minimum)"],
  "4.1.2": ["A", "Name, Role, Value"],
  "4.1.3": ["AA", "Status Messages"]
};

const esc = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const anchor = (id) => `#${id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
const criterionLabel = (id) => (CRITERIA[id] ? `${id} ${CRITERIA[id][1]} (${CRITERIA[id][0]})` : id);
const sortByString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Every finding of one variant, across the two layers, in the report's own shape. */
function findingsFor(variant, markup, browser) {
  const findings = [];
  // The markup audit sees structure, not colour: Datum's binding is audited once, for both schemes.
  for (const state of AUDIT_STATES) {
    for (const entry of markup?.results.datum?.[state.id]?.violations ?? []) {
      findings.push(axeFinding("Markup (jsdom)", entry, state.id));
    }
  }
  if (browser?.results[variant.id]) {
    for (const state of AUDIT_STATES) {
      for (const entry of browser.results[variant.id][state.id]?.violations ?? []) {
        findings.push(axeFinding("Browser (Chrome)", entry, state.id));
      }
    }
  }
  return findings;
}

function axeFinding(layer, entry, state) {
  const contrast = entry.contrast;
  return {
    layer,
    criteria: entry.criteria,
    rule: entry.ruleId,
    part: entry.part,
    component: entry.componentId ?? "—",
    where: entry.target,
    measured: contrast ? `${contrast.ratio}:1 (${contrast.foreground} on ${contrast.background}${contrast.fontSize ? `, ${contrast.fontSize}` : ""})` : entry.summary,
    required: contrast ? `${contrast.expected}` : "—",
    impact: entry.impact,
    state
  };
}

function cell(count, href) {
  return count === 0 ? "✓" : `[✗ ${count}](${href})`;
}

export function renderReport({ markup, browser } = readBaselines()) {
  if (!markup) throw new Error("a11y-report: a11y/baseline/markup.json is missing — run `A11Y_UPDATE=1 npx vitest run tests/a11y-markup.test.ts`");
  const rules = new Map(axe.getRules(WCAG_TAGS).map((rule) => [rule.ruleId, rule]));
  const lines = [];
  const out = (line = "") => lines.push(line);

  out("# Form accessibility");
  out();
  out("How the Datum form, drawn by the Datum binding, was checked with axe-core against the WCAG 2.2 rules it can test, in two ways, and tracked here as-is. These are automated checks only: no manual audit has been done, and axe finds only part of what a person would. This document records what the audits found, it does not decide what is fixed. A design-system binding is audited by its own package; this document covers the form the engine ships. Generated by `npm run a11y:report` in `packages/datum` from the committed baselines under `a11y/baseline/`; a test holds it to those baselines.");
  out();
  out("| Layer | What it sees | What it cannot see | Baseline |");
  out("|---|---|---|---|");
  out("| **Markup** — axe-core in jsdom | Structure of the rendered form: names, roles, states, relationships, language, list and table semantics, target size markup | Colour, layout, anything a stylesheet decides (jsdom lays nothing out) | `markup.json` |");
  out(`| **Browser** — axe-core in headless Chrome | The rendered form as painted: everything above plus colour contrast as drawn, under each colour scheme | Hover and focus states (axe measures the static state) | \`browser.json\`${browser ? "" : " — **not yet run** (the browser audit writes it)"} |`);
  out();
  out(`States audited: ${AUDIT_STATES.map((state) => `**${state.id}** (${state.label.toLowerCase()})`).join(", ")}. Fixture: \`packages/datum/a11y/form.json\`, one of every standard component.`);
  out();
  out(`Versions: axe-core ${markup?.axeVersion ?? "—"}${browser ? `, ${browser.chrome}` : ""}.`);
  out();

  // Summary matrix.
  out("## Summary");
  out();
  out("| Variant | Scheme | Markup (jsdom) | Browser (Chrome) | Status |");
  out("|---|---|---|---|---|");
  const perVariant = new Map();
  const markupFail = AUDIT_STATES.reduce((sum, state) => sum + (markup.results.datum?.[state.id]?.violations.length ?? 0), 0);
  for (const variant of VARIANTS) {
    const findings = findingsFor(variant, markup, browser);
    perVariant.set(variant.id, findings);
    const href = anchor(`${variant.label} ${variant.id}`);
    const browserFail = browser?.results[variant.id] ? AUDIT_STATES.reduce((sum, state) => sum + (browser.results[variant.id][state.id]?.violations.length ?? 0), 0) : undefined;
    const status = findings.length === 0 ? `No automated findings (axe ${markup.axeVersion})` : `${findings.length} finding${findings.length === 1 ? "" : "s"}`;
    out(`| [${esc(variant.label)}](${href}) \`${variant.id}\` | ${variant.scheme} | ${cell(markupFail, href)} | ${browserFail === undefined ? "–" : cell(browserFail, href)} | ${status} |`);
  }
  out();

  // Variant × component matrix.
  out("## Variants by component");
  out();
  out("Findings from both layers filed under the part of the fixture they hit; ✓ means the audits found nothing there, a count links to the variant's findings.");
  out();
  const parts = FIXTURE_PARTS;
  out(`| Variant | ${parts.map((part) => part.label).join(" | ")} |`);
  out(`|---|${parts.map(() => "---").join("|")}|`);
  for (const variant of VARIANTS) {
    const findings = perVariant.get(variant.id);
    const href = anchor(`${variant.label} ${variant.id}`);
    const cells = parts.map((part) => cell(findings.filter((finding) => finding.part === part.id).length, href));
    out(`| \`${variant.id}\` | ${cells.join(" | ")} |`);
  }
  out();

  // Per-variant sections.
  out("## Findings by variant");
  out();
  for (const variant of VARIANTS) {
    const findings = perVariant.get(variant.id);
    out(`### ${variant.label} \`${variant.id}\``);
    out();
    if (findings.length === 0) {
      out("No findings.");
    } else {
      out("| Layer | State | WCAG | Rule | Part | Component | Where | Measured | Required | Impact |");
      out("|---|---|---|---|---|---|---|---|---|---|");
      for (const finding of findings) {
        const partLabel = parts.find((part) => part.id === finding.part)?.label ?? finding.part;
        out(
          `| ${finding.layer} | ${finding.state} | ${finding.criteria.map(criterionLabel).join(", ")} | \`${finding.rule}\` | ${partLabel} | \`${esc(finding.component)}\` | ${esc(finding.where)} | ${esc(finding.measured)} | ${esc(finding.required)} | ${finding.impact} |`
        );
      }
    }
    out();
    const detailLines = [];
    for (const state of AUDIT_STATES) {
      const result = markup.results.datum?.[state.id];
      if (!result) continue;
      detailLines.push(`- Markup (jsdom), ${state.id}: ${result.passes.length} rules passed — ${result.passes.map((id) => `\`${id}\``).join(", ")}${result.incomplete.length ? `; ${result.incomplete.length} axe could not decide (${[...new Set(result.incomplete.map((e) => e.ruleId))].map((id) => `\`${id}\``).join(", ")})` : ""}.`);
    }
    if (browser?.results[variant.id]) {
      for (const state of AUDIT_STATES) {
        const result = browser.results[variant.id][state.id];
        if (!result) continue;
        detailLines.push(`- Browser (Chrome), ${state.id}: ${result.passes.length} rules passed — ${result.passes.map((id) => `\`${id}\``).join(", ")}${result.incomplete.length ? `; ${result.incomplete.length} axe could not decide (${[...new Set(result.incomplete.map((e) => e.ruleId))].map((id) => `\`${id}\``).join(", ")})` : ""}.`);
      }
    }
    out("<details><summary>What passed</summary>");
    out();
    for (const line of detailLines) out(line);
    out();
    out("</details>");
    out();
  }

  // Standards legend.
  out("## Standards legend");
  out();
  out("### Success criteria");
  out();
  const usedCriteria = new Set();
  for (const rule of rules.values()) for (const criterion of criteriaFromTags(rule.tags)) usedCriteria.add(criterion);
  out("| Criterion | Level | Name | Checked by |");
  out("|---|---|---|---|");
  for (const criterion of [...usedCriteria].sort((a, b) => a.split(".").map(Number).reduce((diff, n, i) => diff || n - Number(b.split(".")[i]), 0))) {
    const ruleIds = [...rules.values()].filter((rule) => criteriaFromTags(rule.tags).includes(criterion)).map((rule) => `\`${rule.ruleId}\``);
    const [level, name] = CRITERIA[criterion] ?? ["", criterion];
    out(`| ${criterion} | ${level} | ${name} | ${ruleIds.join(", ")} |`);
  }
  out();
  out("### axe rules");
  out();
  out("| Rule | Criteria | Checks |");
  out("|---|---|---|");
  for (const rule of [...rules.values()].sort((a, b) => sortByString(a.ruleId, b.ruleId))) {
    out(`| \`${rule.ruleId}\` | ${criteriaFromTags(rule.tags).join(", ")} | ${esc(rule.description)} |`);
  }
  out();
  return `${lines.join("\n")}\n`;
}

/** The document, with the path it is committed at. */
export function packageReport() {
  return { path: REPORT_PATH, document: renderReport(readBaselines(root)) };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const { path, document } = packageReport();
  if (process.argv.includes("--stdout")) {
    process.stdout.write(document);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, document);
    console.log(`a11y-report: wrote ${path}`);
  }
}
