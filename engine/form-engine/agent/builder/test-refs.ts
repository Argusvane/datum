/**
 * What a form test names: the component ids and value
 * paths a scenario reads, from the parser's own refs (`FormTestScenario.refs`), never a word
 * scan. Only three kinds are about components: `path`, `collection` and `rowKey` (a row key
 * joins its collection as `items[].sku`); `page`, `journey`, `layout`, `code` and `host` refs
 * name other things and are left out.
 *
 * `list_tests`, `write_test`, `replace_form`'s and `remove_components`' `testsAffected`,
 * `rename_component`'s `testsFollow` and `check_form`'s `tests` area all read refs through here.
 */
import { kernelParseFormTests } from "../../core/form-tests/form-test-parse.js";
import type { FormulaFunctionSignature } from "../../core/expressions/formula-types.js";
import type { FormTestConfiguration, FormTestRef, FormTestScenario } from "../../core/form-tests/form-test-types.js";
import type { TestAffected } from "./types.js";

export interface TestRefs {
  /** The component refs of every scenario in `source`, in source order, each once. */
  refsOf(source: string): string[];
  /** One parsed scenario's component refs, in source order, each once. */
  scenarioRefs(scenario: FormTestScenario): string[];
  /** The test entries whose refs name one of `ids` or `paths` (or a path under one), with those refs. */
  testsMentioning(tests: FormTestConfiguration | undefined, ids: Iterable<string>, paths?: Iterable<string>): TestAffected[];
}

/** A ref's text as a component reference, or `undefined` for a kind that names no component. */
function refText(ref: FormTestRef): string | undefined {
  if (ref.kind === "path" || ref.kind === "collection") {
    return ref.text;
  }
  if (ref.kind === "rowKey") {
    return ref.collection !== undefined && ref.collection !== "" ? `${ref.collection}[].${ref.text}` : ref.text;
  }
  return undefined;
}

/** The refs of a scenario as the tools report them. */
export function scenarioRefs(scenario: FormTestScenario): string[] {
  const out: string[] = [];
  for (const ref of scenario.refs) {
    const text = refText(ref);
    if (text !== undefined && text !== "" && !out.includes(text)) {
      out.push(text);
    }
  }
  return out;
}

/** Whether `ref` reads `name` itself or a value under it (`address.city`, `items[].sku`, `items[0]`). */
function names(ref: string, name: string): boolean {
  if (ref === name) {
    return true;
  }
  if (!ref.startsWith(name)) {
    return false;
  }
  const next = ref.charAt(name.length);
  return next === "." || next === "[";
}

export function createTestRefs(signatures: () => readonly FormulaFunctionSignature[]): TestRefs {
  const refsOf = (source: string): string[] => {
    const parsed = kernelParseFormTests(source, signatures());
    const out: string[] = [];
    for (const scenario of parsed.scenarios) {
      for (const text of scenarioRefs(scenario)) {
        if (!out.includes(text)) {
          out.push(text);
        }
      }
    }
    return out;
  };
  return {
    refsOf,
    scenarioRefs,
    testsMentioning(tests, ids, paths = []) {
      const wanted = [...new Set([...ids, ...paths])].filter((name) => name !== "");
      const out: TestAffected[] = [];
      if (wanted.length === 0) {
        return out;
      }
      for (const entry of tests?.scenarios ?? []) {
        const parsed = kernelParseFormTests(entry.source, signatures());
        const scenario = parsed.scenarios[0];
        const refs = parsed.scenarios.flatMap((one) => scenarioRefs(one));
        const hits = [...new Set(refs.filter((ref) => wanted.some((name) => names(ref, name))))];
        if (hits.length > 0) {
          out.push({ id: entry.id, name: scenario?.name ?? entry.id, refs: hits });
        }
      }
      return out;
    }
  };
}
