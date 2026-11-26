import { checkJourneyTree, findingsSummary, indexJourneyTree } from "../form-engine/builder/journey-designer/journey-checks.js";
import { conditionInWords, indexJourneyForm, pageName, type JourneyFormIndex } from "../form-engine/builder/journey-designer/journey-components.js";
import { treeFromJourney } from "../form-engine/builder/journey-designer/journey-tree.js";
import type { JourneyMapCondition, JourneyMapSource, JourneyMapWords } from "../form-engine/builder/journey-map/journey-map-model.js";
import { conditionTermText, conditionTerms as sharedConditionTerms } from "../form-engine/builder/property-editor/condition-words.js";
import { journeyFlow, type JourneyFlow } from "../form-engine/core/journey/journey-flow.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * A condition in words as terms, for the flow map's tests: the words `conditionInWords` says,
 * split into each question's label and its test, as the designer will lend them to the map;
 * a formula the sentence cannot word is one term. Its joined words are exactly
 * `conditionInWords`'s, which the tests check.
 */
export function conditionTerms(condition: unknown, form: JourneyFormIndex): JourneyMapCondition | undefined {
  const said = sharedConditionTerms(condition, (path) => form.components.get(path)?.label);
  if (!said) {
    return undefined;
  }
  const out: JourneyMapCondition = { join: said.join, terms: said.terms };
  const words = said.terms.map(conditionTermText).join(said.join === "and" ? " and " : " or ");
  if (words !== conditionInWords(condition, form)) {
    throw new Error(`conditionTerms says "${words}", conditionInWords "${conditionInWords(condition, form)}"`);
  }
  return out;
}

/**
 * The words the designer lends the map over `form`, in English: conditions, page names, the
 * findings summary and, unless `field` is false, a form component's label for what a page of
 * a presentation fills or works out.
 */
export function mapWords(form: ComponentNode, journeyName: string, field = true): JourneyMapWords {
  const index = indexJourneyForm(form, "en");
  return {
    journeyName,
    condition: (expression) => conditionTerms(expression, index),
    pageName: (entry) => pageName(entry, index, "en"),
    summary: findingsSummary,
    ...(field ? { field: (componentId: string) => index.components.get(componentId)?.label ?? componentId } : {})
  };
}

/** The designer's view of `journey` over `form`, as the Journeys mode builds it (the form's ids reserved), and its graph facts. */
export function mapSource(form: ComponentNode, journey: Journey): { view: JourneyMapSource; flow: JourneyFlow | undefined } {
  const tree = treeFromJourney(journey, { formIds: [...indexJourneyForm(form, "en").components.keys()] });
  const view: JourneyMapSource = { tree, index: indexJourneyTree(tree), check: checkJourneyTree(form, tree, journey.id) };
  return { view, flow: view.check.journey !== undefined ? journeyFlow(view.check.journey) : undefined };
}
