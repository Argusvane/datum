/**
 * The journey's findings as the Journey panel's card lists them, and the
 * form's fields as the Form fields panel lists them. Both are read off the designer's view
 * (`JourneyDesignView`): the findings `journey-checks.ts` placed, and what the journey asks and
 * where. Pure functions of that view and the form's index; the mode gives each entry the call
 * that runs it (a fix, a placement), so nothing here writes.
 *
 * Each finding keeps its place under the box it is about (`journeyNotes`, the canvas): the card
 * says it again at the top of the panel, errors first, with the fixes the author can take there:
 * "Ask it here" and "Make it optional on the form" for a required form field no step asks,
 * "Remove" for a placement whose form field is gone, "Remove this worked-out value" for one
 * whose field the journey asks already, and "Fill a form field…" for a field of the journey's own
 * whose answer goes nowhere. Selecting a finding selects its node.
 *
 * In the designer's lazy chunk.
 */
import type { ComponentNode } from "../../core/schema/types.js";
import type { BuilderTextOptions } from "../logic/builder-texts.js";
import { builderText } from "./journey-texts-en.js";
import type { JourneyFinding } from "./journey-checks.js";
import type { JourneyDesignView, JourneyFormIndex } from "./journey-components.js";
import { JOURNEY_FIELD_TYPE, JOURNEY_PAGE_TYPE, JOURNEY_ROUTE_TYPE } from "./journey-mode-model.js";

/** What a fix does: ask the form field on the journey's last step, open it on the form, take a node off, move a Check answers step to the end, make a second one a questions step, select a field of the journey's own at its "Fills form field". */
export type JourneyFindingFixKind = "ask" | "optional" | "remove" | "move-end" | "questions" | "fill";

export interface JourneyFindingFix {
  kind: JourneyFindingFixKind;
  label: string;
  /** "ask" and "optional": the form component it is about. */
  componentId?: string;
  /** "remove", "move-end" and "fill": the journey node taken off, the step moved, or the field selected. */
  nodeId?: string;
}

export interface JourneyFindingEntry {
  /** Stable while the finding stands: its place, its code and which of that place's findings it is. */
  id: string;
  severity: "error" | "warning";
  code: string;
  message: string;
  /** The journey node the finding is about, when it has one: what selecting the finding selects. */
  nodeId?: string;
  fixes: JourneyFindingFix[];
}

/** The form component a required field's finding is asked through: the member listed, or the component itself. */
function askTarget(componentId: string, members: readonly string[], form: JourneyFormIndex): string {
  for (let cursor: string | undefined = componentId; cursor !== undefined; cursor = form.components.get(cursor)?.parentId) {
    if (members.includes(cursor)) {
      return cursor;
    }
  }
  return componentId;
}

/**
 * Every finding of the journey on `view`, errors first and then warnings, each in the order the
 * check placed it. `missing` is the set of nodes whose form field the form no longer has
 * (`journeyMissingQuestions`): each such node's findings carry "Remove".
 */
export function journeyFindingEntries(view: JourneyDesignView, form: JourneyFormIndex, missing: ReadonlySet<string>, text?: BuilderTextOptions): JourneyFindingEntry[] {
  const findings = view.check.findings;
  const entries: JourneyFindingEntry[] = [];
  const label = (componentId: string): string => form.components.get(componentId)?.label ?? componentId;
  const push = (scope: string, finding: JourneyFinding, index: number, partial: Pick<JourneyFindingEntry, "fixes"> & { nodeId?: string; message?: string }): void => {
    entries.push({
      id: `${scope}:${finding.code}:${index}`,
      severity: finding.severity,
      code: finding.code,
      message: partial.message ?? finding.message,
      ...(partial.nodeId !== undefined ? { nodeId: partial.nodeId } : {}),
      fixes: partial.fixes
    });
  };

  // The kind of each node of the journey's tree, for the fixes a finding about a Check answers step offers.
  const typeOf = new Map<string, string>();
  const stack: ComponentNode[] = [view.tree];
  while (stack.length > 0) {
    const node = stack.pop() as ComponentNode;
    typeOf.set(node.id, node.type);
    stack.push(...Object.values(node.children ?? {}).flat());
  }
  const fixesOf = (nodeId: string, finding: JourneyFinding): JourneyFindingFix[] => {
    if (missing.has(nodeId)) {
      return [{ kind: "remove", label: builderText("journey.designer.fix.remove", undefined, text), nodeId }];
    }
    const type = typeOf.get(nodeId);
    // A Check answers step is the last the walk takes: a step after it is the step moved, a route out of it is never taken.
    if (finding.code === "page.review-not-last") {
      return type === JOURNEY_PAGE_TYPE
        ? [{ kind: "move-end", label: builderText("journey.designer.fix.moveEnd", undefined, text), nodeId }]
        : type === JOURNEY_ROUTE_TYPE
          ? [{ kind: "remove", label: builderText("journey.designer.fix.remove", undefined, text), nodeId }]
          : [];
    }
    // The journey has one Check answers step: a second is a questions step again, as the finding says.
    if (finding.code === "page.review-repeated" && type === JOURNEY_PAGE_TYPE) {
      return [{ kind: "questions", label: builderText("journey.designer.fix.questions", undefined, text), nodeId }];
    }
    // A form field listed on a Check answers step is not drawn there: it is taken off.
    if (finding.code === "page.review-form-field" && type === JOURNEY_FIELD_TYPE) {
      return [{ kind: "remove", label: builderText("journey.step.takeOff", undefined, text), nodeId }];
    }
    // A worked-out value whose form field the journey already asks: the value goes.
    if (finding.code === "map.target-conflict") {
      return [{ kind: "remove", label: builderText("journey.designer.fix.removeWorkedOut", undefined, text), nodeId }];
    }
    // A field of the journey's own whose answer goes nowhere: its "Fills form field" is the fix.
    if (finding.code === "field.goes-nowhere") {
      return [{ kind: "fill", label: builderText("journey.designer.fix.fill", undefined, text), nodeId }];
    }
    return [];
  };
  findings.root.forEach((finding, at) => push("root", finding, at, { fixes: [] }));
  // One finding about several nodes (a field on two steps, a step id two steps share) is placed on each, one object:
  // the card says it once, selecting the first node it is placed on.
  const listed = new Set<JourneyFinding>();
  for (const [nodeId, list] of findings.byNode) {
    list.forEach((finding, at) => {
      if (!listed.has(finding)) {
        listed.add(finding);
        push(`node:${nodeId}`, finding, at, { nodeId, fixes: fixesOf(nodeId, finding) });
      }
    });
  }
  for (const [componentId, list] of findings.unassigned) {
    list.forEach((finding, at) => {
      const fixes: JourneyFindingFix[] = [];
      let message = finding.message;
      if (finding.required) {
        const field = finding.requiredField ?? componentId;
        // A required field hidden on the form for good cannot be asked on any step: only the form's own Required helps.
        if (finding.hidden !== true) {
          fixes.push({ kind: "ask", label: builderText("journey.designer.fix.ask", undefined, text), componentId: askTarget(componentId, view.unassigned, form) });
        }
        fixes.push({
          kind: "optional",
          label: field === componentId ? builderText("journey.designer.fix.optionalIt", undefined, text) : builderText("journey.designer.fix.optionalNamed", { field: label(field) }, text),
          componentId: field
        });
        if (finding.code === "component.unassigned" && finding.hostBound !== true) {
          message = builderText("journey.designer.findings.requiredLeftOut", { field: label(componentId) }, text);
        }
      } else if (finding.code === "component.unassigned" && finding.hostBound !== true) {
        message = builderText("journey.designer.findings.notAsked", { field: label(componentId) }, text);
      }
      push(`field:${componentId}`, finding, at, { fixes, message });
    });
  }
  return [...entries.filter((entry) => entry.severity === "error"), ...entries.filter((entry) => entry.severity !== "error")];
}

/** One form field in the Form fields panel: where the journey asks it. */
export interface JourneyFieldRow {
  /** The form component's id: what a click or a drop places. */
  id: string;
  label: string;
  type: string;
  required: boolean;
  /** `"none"`: on no step; `"here"`: on the step shown; `"other"`: on steps, none of them the one shown. */
  where: "none" | "here" | "other";
  /** The names of the steps asking it, in step order. */
  steps: string[];
}

/** A step's name as the cards and the map say it, for the row's tag. */
export interface JourneyFieldRowsContext {
  view: JourneyDesignView;
  form: JourneyFormIndex;
  /** The page node shown, if any. */
  shown: string | undefined;
  /** The form's tree, for Required. */
  formRoot: ComponentNode;
  pageName(pageNodeId: string): string;
}

/**
 * The form's fields in form order: those the journey asks on no step (`view.unassigned`, the
 * same list the findings are read from) and those some step asks. A field on the shown step is
 * marked as such, so the panel never offers it twice. A component no step can ask (a calculated
 * or a hidden one, a button) is in neither list and so not here.
 */
export function journeyFieldRows(context: JourneyFieldRowsContext): JourneyFieldRow[] {
  const { view, form } = context;
  const unassigned = new Set(view.unassigned);
  const required = requiredIds(context.formRoot);
  const rows: JourneyFieldRow[] = [];
  for (const component of form.order) {
    const numbers = view.index.pagesListing.get(component.id) ?? [];
    if (!unassigned.has(component.id) && numbers.length === 0) {
      continue;
    }
    const pages = numbers.flatMap((number) => view.index.pages[number - 1] ?? []);
    rows.push({
      id: component.id,
      label: component.label,
      type: component.type,
      required: required.has(component.id),
      where: pages.length === 0 ? "none" : pages.some((page) => page.nodeId === context.shown) ? "here" : "other",
      steps: pages.map((page) => context.pageName(page.nodeId))
    });
  }
  return rows;
}

/** The ids of the form's components that are set Required. */
function requiredIds(root: ComponentNode): Set<string> {
  const out = new Set<string>();
  const stack: ComponentNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as ComponentNode;
    if ((node.configuration as { required?: unknown } | undefined)?.required === true) {
      out.add(node.id);
    }
    stack.push(...Object.values(node.children ?? {}).flat());
  }
  return out;
}
