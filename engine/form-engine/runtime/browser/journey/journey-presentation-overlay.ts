import type { ComponentNode } from "../../../core/schema/types.js";
import type { FormValues } from "../../../core/state/form-state.js";
import type { EffectiveNodeState } from "../../../core/state/effective-state.js";
import { kernelReadFlag } from "../../../core/state/semantic-state.js";
import { kernelJsonValue, kernelOwn, type KernelFoldResult } from "../../../core/state/submittable-fold.js";
// The shared helper's own module: the same function the kernel and the path engine read.
import { journeyHoldsOwnAnswer } from "../../../core/journey/journey-shared.js";
import type { PresentationIndex } from "../../../core/journey/presentation.js";
import { evaluateExpression } from "../../../rules/evaluator/evaluator.js";
import { isEmptyValue } from "../../../validation/core/field-constraints.js";
import type { PresentationNodeState, SemanticResolutionContext } from "../runtime-orchestrator.js";
import type {
  PresentationOverlay,
  PresentationOverlayHost,
  PresentationRoundsInput,
  PresentationRoundsResult
} from "../journey-engine.js";

/** How often a recompute lets the worked-out values and the fold go round before giving up. */
const MAPPING_ROUNDS = 3;

const OWN_HIDDEN: Readonly<Pick<EffectiveNodeState, "visible" | "runValidation" | "requiredApplies" | "submitValue" | "clearValue">> = {
  visible: false,
  runValidation: false,
  requiredApplies: false,
  submitValue: false,
  clearValue: false
};

/** Whether two answers are one: identical, or the same once JSON carries them (a draft's round trip). */
function sameAnswer(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (a === undefined || b === undefined) {
    return false;
  }
  return JSON.stringify(kernelJsonValue(a)) === JSON.stringify(kernelJsonValue(b));
}

function sameIds(a: Readonly<Record<string, true>>, b: Readonly<Record<string, true>>): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) {
    return false;
  }
  return aKeys.every((key) => b[key] === true);
}

/**
 * A running presentation beside the form pipeline. It sits behind the journey engine so it
 * loads with the engine and stays out of the renderer entry. The orchestrator keeps the fold, the calculations and the rule
 * machinery and hands them over ({@link PresentationOverlayHost}, {@link PresentationRoundsInput});
 * this class holds only the sources the worked-out values could last read.
 *
 * What a running presentation adds sits beside the pipeline, never in it:
 *  - before the form's calculations, its **worked-out values** write the form fields they work
 *    out ({@link runMappings}), from the own fields of their page that show;
 *  - after the fold, an **overlay** ({@link resolvePresentation}) works out the state of the own
 *    nodes — shown, disabled, read-only, required — over the fold's view plus the own answers.
 * Which sources show depends on the overlay, and the overlay on the fold, so the three go
 * round until the set of readable sources stops changing, at most {@link MAPPING_ROUNDS} times.
 */
export class PresentationOverlayRunner implements PresentationOverlay {
  /**
   * The sources the worked-out values could read when the last recompute ended: the next one
   * starts from them, so a keystroke usually settles in one round. Only within a session:
   * {@link forget} drops it when the answers are replaced wholesale (a draft put in), since
   * which sources show then depends on answers the last recompute never saw.
   */
  private lastReadable: { index: PresentationIndex; ids: Record<string, true> } | undefined;

  constructor(private readonly host: PresentationOverlayHost) {}

  public forget(): void {
    this.lastReadable = undefined;
  }

  /**
   * Worked-out values, the form's own calculations, the fold, the overlay — and round again
   * while which sources show keeps changing with what was written.
   */
  public recompute({ presentation, working, stored, written: before, locale, note, runValueRules, fold: foldOver }: PresentationRoundsInput): PresentationRoundsResult {
    let fold: KernelFoldResult;
    let overlay: Record<string, PresentationNodeState>;
    const mappings = presentation.workedOut;
    const written: Record<string, unknown> = { ...(before ?? {}) };
    let readable = this.lastReadable !== undefined && this.lastReadable.index === presentation ? this.lastReadable.ids : undefined;
    let settled = mappings.length === 0;
    let round = 0;
    for (;;) {
      round += 1;
      if (readable !== undefined) {
        note(this.runMappings(presentation, readable, working, stored, written));
      }
      note(runValueRules(working));
      fold = foldOver(working);
      overlay = this.resolvePresentation(presentation, fold, working, stored, locale);
      if (mappings.length === 0) {
        break;
      }
      const next = Object.create(null) as Record<string, true>;
      for (const mapping of mappings) {
        for (const sourceId of mapping.sourceIds) {
          if (kernelOwn(overlay, sourceId)?.effective.visible === true) {
            next[sourceId] = true;
          }
        }
      }
      const same = readable !== undefined && sameIds(next, readable);
      readable = next;
      if (same) {
        settled = true;
        break;
      }
      if (round >= MAPPING_ROUNDS) {
        break;
      }
    }
    this.lastReadable = readable !== undefined ? { index: presentation, ids: readable } : undefined;
    return { fold, overlay, settled };
  }

  /**
   * The answer an own value field of the presentation holds: a plain own field's at its `@`
   * key in the stored answers, an alias's at the form field it fills, among the form values.
   */
  private ownAnswer(presentation: PresentationIndex, id: string, working: FormValues, stored: FormValues): unknown {
    const alias = kernelOwn(presentation.aliasOf, id);
    if (alias !== undefined) {
      return kernelOwn(working, alias.targetPath);
    }
    const key = kernelOwn(presentation.ownKeys, id);
    return key !== undefined ? kernelOwn(stored, key) : undefined;
  }

  /**
   * The worked-out values, before the form's own calculations: each writes the form
   * field it works out, from the own value fields of its page that can be read (`readable`: the
   * ones the overlay shows), as JSON carries them. A source that cannot be read is absent.
   *
   * It writes only when at least one readable source is answered. Otherwise it clears its
   * target only while the target still holds what it last wrote (`written`), and then forgets
   * the write: an answer that came from elsewhere — a prefill, a draft — is never cleared.
   * An expression that throws comes to nothing, as a calculation that read nothing would.
   */
  private runMappings(
    presentation: PresentationIndex,
    readable: Readonly<Record<string, true>>,
    working: FormValues,
    stored: FormValues,
    written: Record<string, unknown>
  ): Array<{ componentId: string; value: unknown }> {
    const host = this.host;
    const today = host.today();
    const writes: Array<{ componentId: string; value: unknown }> = [];
    for (const mapping of presentation.workedOut) {
      const path = mapping.targetPath;
      const sources = Object.create(null) as Record<string, unknown>;
      let answered = false;
      for (const sourceId of mapping.sourceIds) {
        if (kernelOwn(readable, sourceId) !== true) {
          continue;
        }
        const value = kernelJsonValue(this.ownAnswer(presentation, sourceId, working, stored));
        if (value === undefined) {
          continue;
        }
        sources[sourceId] = value;
        if (!isEmptyValue(value, kernelOwn(presentation.nodeById, sourceId)?.type ?? "")) {
          answered = true;
        }
      }
      const current = kernelOwn(working, path);
      const held = Object.prototype.hasOwnProperty.call(written, path);
      if (answered) {
        let next: unknown;
        try {
          next = evaluateExpression(mapping.expression, {
            values: sources,
            hostContext: host.hostContext,
            ...(today !== undefined ? { today } : {}),
            ...(host.functions !== undefined ? { functions: host.functions } : {}),
            warn: host.warn,
            regexCache: host.regexCache
          });
        } catch {
          next = undefined;
        }
        if (!Object.is(current, next)) {
          working[path] = next;
          host.applyComputedValue(path, next);
          writes.push({ componentId: mapping.targetId, value: next });
        }
        if (!held || !Object.is(written[path], next)) {
          written[path] = next;
          host.recordWritten(path, next, true);
        }
      } else if (held) {
        if (current !== undefined && sameAnswer(current, written[path])) {
          working[path] = undefined;
          host.applyComputedValue(path, undefined);
          writes.push({ componentId: mapping.targetId, value: undefined });
        }
        delete written[path];
        host.recordWritten(path, undefined, false);
      }
    }
    return writes;
  }

  /**
   * The overlay: the state of each node the presentation owns, over the fold's
   * settled view. Never fed back into the fold — the fold is the server's too, and a server
   * reads no own node.
   *
   * - An own node's rules are evaluated over what the form's rules read (`fold.idValues`) plus
   *   the own answers by id. It shows when its page is on the path, its own visibility holds and
   *   the own layout around it shows; it is required by its tick or its `requiredWhen`
   *   (the rule adds, and is read only on a node that holds an answer).
   * - An **alias** and a **worked-out value's copy** take the form field's state — shown,
   *   disabled, read-only, validated — while their page is on the path; the copy is always
   *   read-only. An alias whose form field is hidden is hidden too, and so neither validated nor
   *   required, whatever the field opts in to while hidden. A reference's placeholder takes the
   *   state of the component it stands for.
   * - The visibility of a node that is, or contains, an alias, a reference or a worked-out
   *   value is never read (`presentation.mapped`): hiding it would hide a form field the server
   *   still asks for.
   *
   * A hidden own node is never validated and never required.
   */
  private resolvePresentation(
    presentation: PresentationIndex,
    fold: KernelFoldResult,
    working: FormValues,
    stored: FormValues,
    locale: string
  ): Record<string, PresentationNodeState> {
    const host = this.host;
    const today = host.today();
    const onPath = Object.create(null) as Record<string, true>;
    for (const pageId of fold.trace?.pages ?? []) {
      onPath[pageId] = true;
    }

    // What an own rule reads: the form's view by component id, then the own answers by id.
    const values = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(fold.idValues)) {
      values[key] = fold.idValues[key];
    }
    const answers = Object.create(null) as Record<string, unknown>;
    for (const id of presentation.order) {
      const kind = presentation.kindOf[id];
      if (kind === "field") {
        const answer = kernelJsonValue(this.ownAnswer(presentation, id, working, stored));
        if (answer !== undefined) {
          answers[id] = answer;
          values[id] = answer;
        }
      } else if (kind === "alias") {
        // The form field's answer as the rules read it: absent while it is hidden and excluded.
        const answer = kernelOwn(fold.idValues, (presentation.aliasOf[id] as { targetId: string }).targetId);
        if (answer !== undefined) {
          answers[id] = answer;
          values[id] = answer;
        }
      }
    }
    const context: SemanticResolutionContext = {
      values,
      locale,
      hostContext: host.hostContext,
      valueOf: (componentId) => kernelOwn(answers, componentId),
      ancestorValuesFor: () => ({}),
      rule: (rules, key) => host.ruleOf(rules, key),
      warn: host.warn,
      regexCache: host.regexCache,
      ...(today !== undefined ? { today } : {}),
      ...(host.functions !== undefined ? { functions: host.functions } : {})
    };

    const hidden = (disabled: boolean, readonly: boolean): EffectiveNodeState => ({ ...OWN_HIDDEN, disabled, readonly });
    const states = Object.create(null) as Record<string, PresentationNodeState>;
    for (const id of presentation.order) {
      const node = presentation.nodeById[id] as ComponentNode;
      const kind = presentation.kindOf[id];
      const shown = kernelOwn(onPath, presentation.pageOf[id] as string) === true;

      if (kind === "reference" || kind === "worked-out") {
        const targetId = kind === "reference" ? (presentation.referenceOf[id] as { componentId: string }).componentId : (presentation.workedOutOf[id] as { targetId: string }).targetId;
        const target = kernelOwn(fold.effective, targetId);
        const effective: EffectiveNodeState =
          shown && target !== undefined ? { ...target, ...(kind === "worked-out" ? { readonly: true } : {}) } : hidden(target?.disabled ?? false, kind === "worked-out" || (target?.readonly ?? false));
        states[id] = { effective, required: kernelOwn(fold.required, targetId) === true, ownRequired: false };
        continue;
      }

      // Required OR Required when, the rule read by truthiness and only where the
      // node holds an answer; with the host context, as the browser reads every rule.
      let ownRequired = kernelReadFlag(node.configuration, "required");
      const rule = host.ruleOf(node.rules, "requiredWhen");
      if (!ownRequired && rule && journeyHoldsOwnAnswer(node)) {
        ownRequired = host.evaluate(rule, node, context) === true;
      }

      if (kind === "alias") {
        const targetId = (presentation.aliasOf[id] as { targetId: string }).targetId;
        const target = kernelOwn(fold.effective, targetId);
        // Hidden with its form field, whatever that field opts in to while hidden (validated,
        // required): those opt-ins are the form's, about its own field; the alias's own
        // Required and checks never block from a node nobody sees.
        states[id] = {
          effective: shown && target !== undefined && target.visible ? { ...target } : hidden(target?.disabled ?? false, target?.readonly ?? false),
          required: ownRequired || kernelOwn(fold.required, targetId) === true,
          ownRequired
        };
        continue;
      }

      const own = host.resolve(node, context);
      const parentId = kernelOwn(presentation.parentOf, id);
      const parent = parentId !== undefined ? kernelOwn(states, parentId)?.effective : undefined;
      const disabled = own.disabled || parent?.disabled === true;
      const readonly = own.readonly || parent?.readonly === true;
      // A node that is, or holds, something mapped to the form shows whenever its page does.
      const visible = shown && (kernelOwn(presentation.mapped, id) === true || own.visible) && parent?.visible !== false;
      states[id] = {
        // Never submitted, shown or not: an own answer stays in the browser.
        effective: visible ? { visible: true, disabled, readonly, runValidation: true, requiredApplies: true, submitValue: false, clearValue: false } : hidden(disabled, readonly),
        required: ownRequired,
        ownRequired
      };
    }
    return states;
  }
}
