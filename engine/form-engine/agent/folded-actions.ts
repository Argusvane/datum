/**
 * The folded-action convention's argument check. An area folds into one tool with an action argument (`drafts`, `try_it`,
 * `languages`, `documents`, and `remove_part`, whose `kind` plays the action's role). The
 * registrar's schema check has already dropped unknown keys and refused wrong types; what is
 * left is per action: an argument the action needs and did not get, an action the given `kind`
 * does not have, an argument only another kind reads, and an argument this action does not read.
 * Every tool spells those the same way through this one helper, so a model meets one grammar.
 *
 * Pure: no DOM, imports only `agent/`. The registrar does not call it; each folded tool does,
 * first thing in its body, and throws `bad-input` with the problems (every one at once) or
 * returns the warnings beside its result.
 */

import type { SchemaProblem } from "./schema-check.js";

/** How one folded tool's actions read their arguments. */
export interface FoldedActionSpec {
  /** The name of the action key: `"action"`, or `"kind"` for `remove_part`. */
  key: string;
  /** That key's value in this call (after the schema check, so one of its enum). */
  action: string;
  /** `documents`' `kind` value in this call, when the tool has one beside its action. */
  kind?: string;
  /** Per action, the arguments it cannot run without (`required for action '<action>'`). */
  needs: Record<string, readonly string[]>;
  /** Per action, the arguments it reads besides those it needs; anything else is warned and dropped. */
  reads: Record<string, readonly string[]>;
  /**
   * Arguments every action reads, never warned: the handle (`builder` / `form`),
   * `expectedRevision`, `documents.kind`, and `remove_part`'s `kind` and `id`. The
   * action key itself is never warned either.
   */
  always?: readonly string[];
  /** Per kind, the actions it has, in enum order; another action is `an action for kind '<kind>': <list>`. */
  kindActions?: Record<string, readonly string[]>;
  /** Arguments only one kind reads (`toIndex` → `pdf_layout`); given with another kind they are `kind '<kind>' only`. */
  kindOnly?: Record<string, string>;
}

export interface FoldedActionCheck {
  /** Every problem at once, for `bad-input { problems }`; empty when the call may run. */
  problems: SchemaProblem[];
  /** `ignored argument for action '<action>': <key>`, one per argument the action does not read. */
  warnings: string[];
}

function given(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
}

/**
 * Checks one call of a folded tool against its spec. The
 * problems come in a fixed order: the action against the kind, then the action's missing
 * arguments in `needs` order, then kind-only arguments in input order. An action the kind does
 * not have is not asked for its arguments (the model changes the action first, and the other
 * action needs others). Arguments named in a problem are not also warned.
 */
export function checkActionArgs(input: Record<string, unknown>, spec: FoldedActionSpec): FoldedActionCheck {
  const problems: SchemaProblem[] = [];
  const named = new Set<string>();
  const { action, kind } = spec;

  let actionFitsKind = true;
  if (kind !== undefined) {
    const actions = spec.kindActions?.[kind];
    if (actions !== undefined && !actions.includes(action)) {
      actionFitsKind = false;
      problems.push({ key: spec.key, expected: `an action for kind '${kind}': ${actions.join(", ")}` });
      named.add(spec.key);
    }
  }

  const needs = spec.needs[action] ?? [];
  if (actionFitsKind) {
    for (const key of needs) {
      if (!given(input, key)) {
        problems.push({ key, expected: `required for action '${action}'` });
        named.add(key);
      }
    }
  }

  if (kind !== undefined && spec.kindOnly !== undefined) {
    for (const key of Object.keys(input)) {
      const only = spec.kindOnly[key];
      if (only !== undefined && only !== kind && given(input, key) && !named.has(key)) {
        problems.push({ key, expected: `kind '${only}' only` });
        named.add(key);
      }
    }
  }

  const read = new Set<string>([spec.key, ...(spec.always ?? []), ...needs, ...(spec.reads[action] ?? [])]);
  const warnings: string[] = [];
  for (const key of Object.keys(input)) {
    if (given(input, key) && !read.has(key) && !named.has(key)) {
      warnings.push(`ignored argument for action '${action}': ${key}`);
    }
  }
  return { problems, warnings };
}
