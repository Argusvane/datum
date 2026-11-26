/**
 * Which tests pin which rules: the Tests panel's Untested list and
 * the Logic editor's "Pinned by" line read the same answer. It is the command line's coverage
 * (`builder/logic/coverage.ts`) with the panel's reach, `written`: a scenario pins the rules its
 * expectations read as soon as it parses, before the first run, because a pin says what the
 * author meant to test and a failing or not-yet-run test still means it.
 *
 * An entry without a parsed scenario (a source that does not parse as exactly one) pins nothing:
 * there is no statement to read. A scenario that skips itself (`skip "..."`) still pins, since the
 * author has written what it will check.
 */
import type { FormulaFunctionSignature } from "../../core/expressions/formula-types.js";
import type { ComponentNode, FormDefinition } from "../../core/schema/types.js";
import type { BuilderTextOptions } from "../logic/builder-texts.js";
import { coverageOf, type CoverageRule, type CoveredScenario } from "../logic/coverage.js";
import type { TestsEntryModel, TestsPin } from "./tests-model.js";

/** The panel's view of coverage: every coverable rule, who pins it, and the counts for the foot line. */
export interface TestsUntestedView {
  /** Every coverable rule in the Logic model's order; `scenarios` holds the names of the entries that pin it. */
  rules: CoverageRule[];
  /** Rule id to the entries that pin it; a rule nothing pins is absent. */
  pins: ReadonlyMap<string, TestsPin[]>;
  tested: number;
  untested: number;
}

/**
 * Coverage over the entries, with the entry as the unit. `coverageOf` names a scenario by its name,
 * and two entries may share one (the later is reported `duplicateName` and still runs), so each is
 * handed over under its id and the ids are mapped back to entries afterwards.
 *
 * `signatures` is part of the call for symmetry with the scaffold and the runner: the entries are
 * already parsed with the signatures in force, so nothing is parsed again here. `text` words the
 * rules' sentences in the builder's language; the pins do not depend on it.
 */
function viewOf(
  root: ComponentNode,
  definition: FormDefinition,
  entries: readonly TestsEntryModel[],
  _signatures: readonly FormulaFunctionSignature[],
  text?: BuilderTextOptions
): TestsUntestedView {
  const byId = new Map<string, TestsEntryModel>();
  const covered: CoveredScenario[] = [];
  for (const entry of entries) {
    if (entry.scenario === undefined) {
      continue;
    }
    byId.set(entry.id, entry);
    covered.push({ scenario: { ...entry.scenario, name: entry.id }, status: "passed" });
  }
  // The root is the builder's committed tree, which may be ahead of the definition's own copy.
  const words = text === undefined ? undefined : { ...(text.locale !== undefined ? { locale: text.locale } : {}), ...(text.catalog !== undefined ? { catalog: text.catalog } : {}) };
  const report = coverageOf({ ...definition, root }, covered, { reach: "written", ...(words !== undefined ? { text: words } : {}) });
  const pins = new Map<string, TestsPin[]>();
  const rules = report.rules.map((rule) => {
    const pinning: TestsPin[] = [];
    for (const id of rule.scenarios) {
      const entry = byId.get(id);
      if (entry !== undefined) {
        pinning.push({ id: entry.id, name: entry.name });
      }
    }
    if (pinning.length > 0) {
      pins.set(rule.id, pinning);
    }
    return { ...rule, scenarios: pinning.map((pin) => pin.name) };
  });
  return { rules, pins, tested: report.tested, untested: report.untested };
}

/** Rule id to the tests that pin it, in the entries' order; a rule nothing pins is absent. */
export function testsPinsOf(
  root: ComponentNode,
  definition: FormDefinition,
  entries: readonly TestsEntryModel[],
  signatures: readonly FormulaFunctionSignature[]
): ReadonlyMap<string, TestsPin[]> {
  return viewOf(root, definition, entries, signatures).pins;
}

/**
 * The Untested list's rows and the foot line's counts (see {@link TestsUntestedView}); `text` is
 * the panel's language and catalog, so the sentences read as the Logic workspace's do.
 */
export function untestedRules(
  root: ComponentNode,
  definition: FormDefinition,
  entries: readonly TestsEntryModel[],
  signatures: readonly FormulaFunctionSignature[],
  text?: BuilderTextOptions
): TestsUntestedView {
  return viewOf(root, definition, entries, signatures, text);
}
